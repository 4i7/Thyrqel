import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OperationJournal } from '../src/session/operation-journal.js';

test('concurrent identical deliveries share execution and conflicting payloads cannot reuse an ID', async () => {
  const journal = new OperationJournal();
  let effects = 0;
  let finish!: (value: string) => void;
  const action = () => { effects++; return new Promise<string>(resolve => { finish = resolve; }); };
  const first = journal.execute(journal.epoch, 'operation_00000001', 'input', action);
  const second = journal.execute(journal.epoch, 'operation_00000001', 'input', action);
  assert.equal(first, second);
  await assert.rejects(journal.execute(journal.epoch, 'operation_00000001', 'other', action), { code: 'OPERATION_CONFLICT' });
  finish('accepted');
  assert.deepEqual(await Promise.all([first, second]), ['accepted', 'accepted']);
  assert.equal(await journal.execute(journal.epoch, 'operation_00000001', 'input', action), 'accepted');
  assert.equal(effects, 1);
});

test('failed, expired, old-epoch and over-capacity requests never repeat an effect', async () => {
  const journal = new OperationJournal(3, 3);
  let effects = 0;
  const perform = async () => { effects++; return 'abc'; };
  await journal.execute(journal.epoch, 'operation_00000001', 'one', perform);
  await journal.execute(journal.epoch, 'operation_00000002', 'two', perform);
  await assert.rejects(journal.execute(journal.epoch, 'operation_00000001', 'one', perform), { code: 'RESULT_EXPIRED' });
  await assert.rejects(journal.execute(journal.epoch, 'operation_00000003', 'three', async () => {
    effects++; throw new Error('reply lost after input');
  }), /reply lost/);
  await assert.rejects(journal.execute(journal.epoch, 'operation_00000003', 'three', perform), { code: 'RESULT_EXPIRED' });
  await assert.rejects(journal.execute(journal.epoch, 'operation_00000004', 'four', perform), { code: 'JOURNAL_FULL' });
  const restarted = new OperationJournal();
  await assert.rejects(restarted.execute(journal.epoch, 'operation_00000001', 'one', perform), { code: 'STALE_EPOCH' });
  assert.equal(effects, 3);
});
