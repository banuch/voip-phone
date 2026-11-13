import { MockDataService } from './mock-data-service';

describe('MockDataService rules match the server', () => {
  it('enforces one call per operator and busy ATMs', async () => {
    const m = new MockDataService(40);
    await m.login('operator1', 'x');
    await m.heartbeat(true);
    await m.setPresence('AVAILABLE');
    const mine = await m.atms({ mine: true, registration: 'REGISTERED', status: 'ACTIVE', pageSize: 5 });
    const [a, b] = mine.items;
    const r = await m.initiateCall({ atmId: a!.id, requestId: 'r1' });
    expect(r.queued).toBe(false);
    await expect(m.initiateCall({ atmId: b!.id, requestId: 'r2' })).rejects.toMatchObject({ code: 'OPERATOR_BUSY' });
    const replay = await m.initiateCall({ atmId: a!.id, requestId: 'r1' });
    expect(replay.queued === false && replay.replayed).toBe(true);
  });

  it('refuses auditors', async () => {
    const m = new MockDataService(10);
    await m.login('auditor', 'x');
    await expect(m.initiateCall({ atmId: 'atm-1', requestId: 'r' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
