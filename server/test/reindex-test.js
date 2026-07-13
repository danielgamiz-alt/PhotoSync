'use strict';

/**
 * Unit test for Storage.reindex — the "Scan for new files" engine. Focuses on
 * folders a customer arranged themselves (not the uploader's YYYY/MM layout):
 * a bare year folder, an arbitrary folder with no date, and per-user layouts.
 * Verifies each file is imported with the right owner, sort date, and
 * datePrecision, that unsupported files are counted as skipped, and that a
 * second scan is a no-op.
 *
 * Run with: node test/reindex-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Storage } = require('../src/storage');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

// Drops a file at <root>/<relPath> (creating parent folders) with unique bytes
// so every file hashes differently.
function drop(root, relPath, seed) {
  const abs = path.join(root, relPath.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from('photo-' + seed));
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-reindex-'));
  const storage = new Storage(dir);
  await storage.init();

  try {
    // The uploader's own layout: real capture month.
    drop(dir, '2024/07/vacation.jpg', 1);
    // A year folder the owner made by hand, with a sub-folder and no metadata.
    drop(dir, '2025/Grandma/old1.jpg', 2);
    drop(dir, '2025/Grandma/old2.jpg', 3);
    // Same, but under a named account.
    drop(dir, 'alice/2023/Trip/scan.png', 4);
    // An arbitrary folder dropped at the root: no date anywhere.
    drop(dir, 'Old Photos/mystery.jpeg', 5);
    // A non-photo file that should be reported as skipped, not imported.
    drop(dir, '2025/Grandma/notes.txt', 6);

    const res = await storage.reindex();
    check('reindex: imported all 5 photos', res.added === 5, `added ${res.added}`);
    check('reindex: counted the unsupported file as skipped', res.skipped === 1, `skipped ${res.skipped}`);
    check('reindex: total matches index', res.total === 5, `total ${res.total}`);

    const byPath = Object.fromEntries(storage.list().map((m) => [m.path, m]));

    const exact = byPath['2024/07/vacation.jpg'];
    check('YYYY/MM → exact date, default user',
      exact && exact.user === 'default' && exact.datePrecision === 'exact'
        && new Date(exact.takenAt).getFullYear() === 2024
        && new Date(exact.takenAt).getMonth() === 6,
      JSON.stringify(exact));

    const yearFolder = byPath['2025/Grandma/old1.jpg'];
    check('YYYY/<folder> → year precision, sorts under that year',
      yearFolder && yearFolder.user === 'default' && yearFolder.datePrecision === 'year'
        && new Date(yearFolder.takenAt).getFullYear() === 2025,
      JSON.stringify(yearFolder));

    const userYear = byPath['alice/2023/Trip/scan.png'];
    check('user/YYYY/<folder> → alice owns it, year precision',
      userYear && userYear.user === 'alice' && userYear.datePrecision === 'year'
        && new Date(userYear.takenAt).getFullYear() === 2023,
      JSON.stringify(userYear));

    const undated = byPath['Old Photos/mystery.jpeg'];
    check('arbitrary root folder → default user, no invented account, undated',
      undated && undated.user === 'default' && undated.datePrecision === 'none' && undated.takenAt === 0,
      JSON.stringify(undated));
    check('arbitrary root folder did NOT become a phantom account',
      !storage.list().some((m) => m.user === 'Old Photos'));

    // Running it again finds nothing new (already indexed).
    const again = await storage.reindex();
    check('reindex is idempotent: second scan adds 0', again.added === 0, `added ${again.added}`);

    // The imported files must survive a restart — reopen the same folder with a
    // fresh Storage (as the app does on launch) and confirm they're all there.
    const reopened = new Storage(dir);
    await reopened.init();
    check('reindex persists across a restart', reopened.count() === 5, `count ${reopened.count()}`);
    check('restart keeps the year-folder owner (alice)',
      reopened.list().some((m) => m.user === 'alice' && m.path === 'alice/2023/Trip/scan.png'));

    // Checkpointing: a big scan saves progress incrementally, not just at the
    // end, so an interrupted first scan doesn't lose everything. Drop enough
    // new files and use a tiny saveEvery, then count saveIndex calls.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-reindex-ckpt-'));
    const ck = new Storage(dir2);
    await ck.init();
    for (let i = 0; i < 7; i++) drop(dir2, `2020/pic${i}.jpg`, 'ck' + i);
    let saves = 0;
    const realSave = ck.saveIndex.bind(ck);
    ck.saveIndex = async () => { saves++; return realSave(); };
    const ckRes = await ck.reindex({ saveEvery: 2 });
    check('checkpoint: all 7 imported', ckRes.added === 7, `added ${ckRes.added}`);
    check('checkpoint: saved progress mid-scan (not just once at the end)', saves > 1, `saves ${saves}`);
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('test harness error:', err);
  process.exit(1);
});
