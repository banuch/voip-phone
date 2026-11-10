import { DatabaseService } from '../src/common/db/database.service';
import { describeDb } from './fixtures';

describeDb('leadership (advisory locks)', () => {
  const a = new DatabaseService();
  const b = new DatabaseService();
  afterAll(async () => {
    await a.onModuleDestroy();
    await b.onModuleDestroy();
  });

  it('allows one holder per key and hands over after release', async () => {
    const key = 7399999;
    const first = await a.holdLeadership(key);
    expect(first).not.toBeNull();
    expect(await b.holdLeadership(key)).toBeNull();
    expect(await first!.alive()).toBe(true);
    await first!.release();
    const second = await b.holdLeadership(key);
    expect(second).not.toBeNull();
    await second!.release();
  });

  it('per-tick job locks are exclusive while held', async () => {
    const r1 = await a.tryLeader(7399998);
    expect(r1).not.toBeNull();
    expect(await b.tryLeader(7399998)).toBeNull();
    await r1!();
    const r2 = await b.tryLeader(7399998);
    expect(r2).not.toBeNull();
    await r2!();
  });
});
