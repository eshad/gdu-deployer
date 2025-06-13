const os = require('os');
const { Client } = require('pg');
const SSH2Promise = require('ssh2-promise');
const ProgressBar = require('cli-progress');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

// === Log to file ===

function logFailure(ip, reason) {
  const logPath = path.join(process.cwd(), 'failed_servers.log'); // ✅ write to actual disk, not pkg snapshot

  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} - ${ip} - ${reason}\n`);
  } catch (err) {
    console.error(`❌ Failed to write to log: ${err.message}`);
  }
}

// === CONFIG ===
const db = new Client({
  user: 'emcs',
  host: 'localhost',
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

// === Ping check ===

//function isReachable(ip) {
//  try {
//    execSync(`ping -c 1 -W 1 ${ip}`, { stdio: 'ignore' });
//    return true;
//  } catch {
//    return false;
//  }
//}
function isReachable(ip) {
  const platform = os.platform();
  const pingCmd =
    platform === 'win32'
      ? `ping -n 1 -w 1000 ${ip}`     // Windows
      : `ping -c 1 -W 1 ${ip}`;       // Linux/macOS

  try {
    execSync(pingCmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}


// === Cleanup task ===

async function runCleanup(ipaddress, username, password) {
  const ssh = new SSH2Promise({
    host: ipaddress,
    username,
    password,
    tryKeyboard: true,
  });

  try {
    await ssh.connect();

    console.log(`🔪 Killing Chrome on ${ipaddress}`);
    try {
      await ssh.exec('sudo killall chrome || true');
    } catch (e) {
      console.error(`⚠️ Failed to kill Chrome on ${ipaddress}: ${e.message}`);
      logFailure(ipaddress, `Failed to kill Chrome: ${e.message}`);
    }

    console.log(`🧹 Cleaning /home/gdu/Documents on ${ipaddress}`);
    try {
      await ssh.exec('rm -rf /home/gdu/Documents/*');
    } catch (e) {
      console.error(`⚠️ Failed to clean Documents on ${ipaddress}: ${e.message}`);
      logFailure(ipaddress, `Failed to clean Documents: ${e.message}`);
    }

    console.log(`▶️ Starting page-run-gen.sh in background on ${ipaddress}`);
    try {
      await ssh.exec('nohup bash /home/gdu/page-run-gen.sh > /dev/null 2>&1 & sleep 1');
      logFailure(ipaddress, 'page-run-gen.sh started successfully (background)');
    } catch (e) {
      console.error(`❌ Failed to run script on ${ipaddress}: ${e.message}`);
      logFailure(ipaddress, `Failed to run script: ${e.message}`);
    }

    await ssh.close();
  } catch (err) {
    throw new Error(`${ipaddress}: SSH error - ${err.message}`);
  }
}

// === MAIN ===
(async () => {
  const servers = await getServerList();

  if (!servers.length) {
    console.log("⚠️ No active servers found.");
    return;
  }

  const progress = new ProgressBar.SingleBar({}, ProgressBar.Presets.shades_classic);
  progress.start(servers.length, 0);

  for (let i = 0; i < servers.length; i++) {
    const { ipaddress, username, password, isdeleted } = servers[i];

    if (isdeleted === true || !ipaddress || !username || !password) {
      progress.update(i + 1);
      continue;
    }

    console.log(`\n➡️ Cleaning up ${ipaddress}`);

    if (!isReachable(ipaddress)) {
      console.error(`❌ ${ipaddress} is unreachable.`);
      logFailure(ipaddress, 'Unreachable');
      progress.update(i + 1);
      continue;
    }

    try {
      await runCleanup(ipaddress, username, password);
      console.log(`✅ Cleaned and restarted on ${ipaddress}`);
    } catch (err) {
      console.error(`❌ ${err.message}`);
      logFailure(ipaddress, err.message);
    }

    progress.update(i + 1);
  }

  progress.stop();
  console.log('✅ Cleanup complete.');
})();

// === Catch any unhandled promise errors globally ===
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
  process.exit(1);
});
