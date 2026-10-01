import { build } from 'esbuild';
import { writeFileSync } from 'fs';

// ---- 极简跨标签页环境：共享存储 + storage 事件 ----
function makeEnv() {
  const shared = new Map();
  const mk = (id) => {
    const listeners = new Map();
    const storage = {
      getItem: (k) => (shared.has(k) ? shared.get(k) : null),
      setItem: (k, v) => {
        const old = shared.get(k) ?? null;
        shared.set(k, String(v));
        others(id).forEach((o) => o.listeners.get('storage')?.forEach((fn) => fn({ key: k, oldValue: old, newValue: String(v) })));
      },
      removeItem: (k) => shared.delete(k)
    };
    const page = { id, listeners, localStorage: storage, addEventListener(t, fn) { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)).add(fn); }, removeEventListener() {}, setTimeout, clearTimeout };
    pages.push(page);
    return page;
  };
  const pages = [];
  const others = (id) => pages.filter((p) => p.id !== id);
  return { mk };
}

const bundle = await build({ entryPoints: ['/workspace/src/collaboration.ts'], bundle: true, format: 'iife', globalName: 'Collab', write: false, platform: 'browser' });
writeFileSync('/tmp/lease.js', bundle.outputFiles[0].text);

let pass = 0, fail = 0;
const assert = (c, m) => { c ? pass++ : (fail++, console.error('FAIL:', m)); };

function loadCollab(win) {
  const fn = new Function('window', 'localStorage', bundle.outputFiles[0].text + '; return Collab;');
  return fn(win, win.localStorage);
}

const env = makeEnv();
const winA = env.mk('A');
const winB = env.mk('B');
const A = loadCollab(winA);
const B = loadCollab(winB);

// 1. A 先获取租约成功
const leaseA = A.acquireLease('p1', 'sessionA', '甲页面');
assert(leaseA !== null, 'A 首次获取租约成功');
// 2. B 获取失败
assert(B.acquireLease('p1', 'sessionB', '乙页面') === null, 'A 持锁时 B 获取失败');
// 3. A 续租
const renewedA = A.renewLease(leaseA);
assert(renewedA !== null && renewedA.holderId === 'sessionA', 'A 续租成功');
// 4. 非持有者用自己的身份续租失败
assert(B.renewLease({ ...leaseA, holderId: 'sessionB' }) === null, 'B 用自己身份不能续 A 的租约');
// 5. A 释放后 B 立即接管
A.releaseLease('p1', 'sessionA');
const leaseB = B.acquireLease('p1', 'sessionB', '乙页面');
assert(leaseB !== null && leaseB.holderId === 'sessionB', 'A 释放后 B 接管成功');
// 6. 过期后 A 可抢占
const expired = { ...leaseB, expiresAt: new Date(Date.now() - 1000).toISOString() };
winA.localStorage.setItem('sologsb-1030-lease-v1', JSON.stringify({ p1: expired }));
assert(A.acquireLease('p1', 'sessionA', '甲页面') !== null, '租约过期后 A 可抢占');
// 7. currentLeaseFor 过期返回 null
winB.localStorage.setItem('sologsb-1030-lease-v1', JSON.stringify({ p1: { ...expired, holderId: 'sessionX' } }));
assert(B.currentLeaseFor('p1') === null, '过期租约 currentLeaseFor 返回 null');
// 8. 不同项目互不干扰
winA.localStorage.setItem('sologsb-1030-lease-v1', JSON.stringify({}));
assert(A.acquireLease('projX', 'sessionA', '甲') !== null, 'A 可获取另一项目租约');
assert(B.acquireLease('projY', 'sessionB', '乙') !== null, '不同项目可各持一锁');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
