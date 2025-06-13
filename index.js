const { Client } = require('pg');
const SSH2Promise = require('ssh2-promise');
const { Client: SSHClient } = require('ssh2');
const ProgressBar = require('cli-progress');
const fs = require('fs');
const path = require('path');

// === Constants ===
const LOCAL_BUILD_PATH = path.join(path.dirname(process.execPath), 'build');
const REMOTE_BUILD_PATH = '/var/www/pids/ClientApp/build';

const db = new Client({
  user: 'emcs',
  host: '10.147.84.12',
  database: 'ASL_DB_V4',
  password: 'c915db69e3d26f561c3ce2d8',
  port: 5432,
});

// === Fetch server list ===
async function getServerList() {
  try {
    await db.connect();
    const res = await db.query(
      'SELECT ipaddress, username, password, isdeleted FROM pid_gdustation WHERE isdeleted != true'
    );
    await db.end();
    return res.rows;
  } catch (err) {
    console.error("❌ Failed to fetch server list:", err.message);
    process.exit(1);
  }
}

// === Upload single file ===
async function uploadFile(sftp, localFilePath, remotePath) {
  await new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(localFilePath);
    const writeStream = sftp.createWriteStream(remotePath);

    writeStream.on('close', resolve);
    writeStream.on('error', reject);
    readStream.pipe(writeStream);
  });
}

// === Recursively upload a folder ===
async function uploadDirectory(sftp, localDir, remoteDir) {
  const entries = fs.readdirSync(localDir, { withFileTypes: true });

  try {
    await sftp.mkdir(remoteDir, true);
  } catch (e) {
    // Ignore if already exists
  }

  for (const entry of entries) {
    const localPath = path.join(localDir, entry.name);
    const remotePath = `${remoteDir}/${entry.name}`;

    if (entry.isDirectory()) {
      await uploadDirectory(sftp, localPath, remotePath);
    } else if (entry.isFile()) {
      await uploadFile(sftp, localPath, remotePath);
    }
  }
}

// === Upload dispatcher ===
async function uploadToServer(ipaddress, username, password, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();

    conn.on('ready', () => {
      conn.sftp(async (err, sftp) => {
        if (err) {
          conn.end();
          return reject(new Error(`SFTP error: ${err.message}`));
        }

        try {
          await uploadDirectory(sftp, localPath, remotePath);
          conn.end();
          resolve();
        } catch (e) {
          conn.end();
          reject(new Error(`Upload failed: ${e.message}`));
        }
      });
    });

    conn.on('error', (err) => {
      reject(new Error(`SSH connection error: ${err.message}`));
    });

    conn.connect({
      host: ipaddress,
      port: 22,
      username,
      password,
      readyTimeout: 20000
    });
  });
}

// === MAIN ===
(async () => {
  if (!fs.existsSync(LOCAL_BUILD_PATH)) {
    console.error(`❌ Local build folder not found: ${LOCAL_BUILD_PATH}`);
    process.exit(1);
  }

  const servers = await getServerList();

  if (!servers.length) {
    console.log("⚠️ No active servers found.");
    return;
  }

  const progress = new ProgressBar.SingleBar({}, ProgressBar.Presets.shades_classic);
  progress.start(servers.length, 0);

  for (let i = 0; i < servers.length; i++) {
    const { ipaddress, username, password, isdeleted } = servers[i];

    if (isdeleted === true) {
      console.log(`⛔ Skipping deleted: ${ipaddress}`);
      progress.update(i + 1);
      continue;
    }

    if (!ipaddress || !username || !password) {
      console.warn(`⚠️ Skipping incomplete entry at index ${i}`);
      progress.update(i + 1);
      continue;
    }

    console.log(`\n➡️ Uploading to ${ipaddress} ...`);

    try {
      await uploadToServer(ipaddress, username, password, LOCAL_BUILD_PATH, REMOTE_BUILD_PATH);
      console.log(`✅ Upload successful: ${ipaddress}`);
    } catch (err) {
      console.error(`❌ Upload failed for ${ipaddress}: ${err.message}`);
    }

    progress.update(i + 1);
  }

  progress.stop();
  console.log('✅ Deployment complete.');
})();
