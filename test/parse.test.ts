import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SOL_MINT, WSOL_MINT } from '../server/config.ts';
import { parseRawTransaction } from '../server/providers/parse-raw-tx.ts';
import { entityKey } from '../server/tracked.ts';

const base = (instructions: any[], meta: any = {}, keys: string[] = []) => ({
  slot: 123,
  blockTime: 1_700_000_000,
  meta: { err: null, innerInstructions: [], preTokenBalances: [], postTokenBalances: [], ...meta },
  transaction: { signatures: ['SIG'], message: { accountKeys: keys.map((pubkey) => ({ pubkey })), instructions } },
});

test('перевод SOL', () => {
  const tx = base([{ program: 'system', parsed: { type: 'transfer', info: { source: 'Alice', destination: 'Bob', lamports: 1_500_000_000 } } }]);
  assert.deepEqual(parseRawTransaction(tx), [
    { signature: 'SIG', slot: 123, blockTime: 1_700_000_000, from: 'Alice', to: 'Bob', mint: SOL_MINT, amountRaw: '1500000000', decimals: 9, uiAmount: 1.5 },
  ]);
});

test('перевод токена: токен-аккаунты заменяются владельцами, внутренние инструкции учитываются', () => {
  const tx = base(
    [],
    {
      innerInstructions: [{ index: 0, instructions: [{ program: 'spl-token', parsed: { type: 'transfer', info: { source: 'AliceAta', destination: 'BobAta', amount: '2500000', authority: 'Alice' } } }] }],
      preTokenBalances: [{ accountIndex: 0, mint: 'MintX', owner: 'Alice', uiTokenAmount: { decimals: 6 } }],
      postTokenBalances: [{ accountIndex: 1, mint: 'MintX', owner: 'Bob', uiTokenAmount: { decimals: 6 } }],
    },
    ['AliceAta', 'BobAta'],
  );
  const [t] = parseRawTransaction(tx);
  assert.equal(t.from, 'Alice');
  assert.equal(t.to, 'Bob');
  assert.equal(t.mint, 'MintX');
  assert.equal(t.uiAmount, 2.5);
});

test('обёртка в WSOL на свой аккаунт — не перевод; WSOL другому кошельку считается SOL', () => {
  const wrap = base(
    [{ program: 'system', parsed: { type: 'transfer', info: { source: 'Alice', destination: 'AliceWsol', lamports: 1e9 } } }],
    { postTokenBalances: [{ accountIndex: 0, mint: WSOL_MINT, owner: 'Alice', uiTokenAmount: { decimals: 9 } }] },
    ['AliceWsol'],
  );
  assert.deepEqual(parseRawTransaction(wrap), []);

  const send = base(
    [{ program: 'spl-token', parsed: { type: 'transferChecked', info: { source: 'AliceWsol', destination: 'PoolWsol', mint: WSOL_MINT, tokenAmount: { amount: '1000000000', decimals: 9 } } } }],
    {
      preTokenBalances: [{ accountIndex: 0, mint: WSOL_MINT, owner: 'Alice', uiTokenAmount: { decimals: 9 } }, { accountIndex: 1, mint: WSOL_MINT, owner: 'Pool', uiTokenAmount: { decimals: 9 } }],
    },
    ['AliceWsol', 'PoolWsol'],
  );
  const [t] = parseRawTransaction(send);
  assert.equal(t.mint, SOL_MINT);
  assert.equal(t.uiAmount, 1);
  assert.equal(t.to, 'Pool');
});

test('неуспешная транзакция пропускается', () => {
  const tx = base([{ program: 'system', parsed: { type: 'transfer', info: { source: 'A', destination: 'B', lamports: 5 } } }], { err: { InstructionError: [0, 'Custom'] } });
  assert.deepEqual(parseRawTransaction(tx), []);
});

test('ключ сущности склеивает кошельки одного имени', () => {
  const same = (names: string[], key: string) => assert.deepEqual([...new Set(names.map(entityKey))], [key], names.join(' | '));
  same(['Cupsey', 'cupsey', 'Cupsey2', 'Cupsey3'], 'cupsey');
  same(['Gake', 'Gake Side', 'Gake Side2'], 'gake');
  same(['Yugi', 'Yugi Bundle', 'Yugi DEV'], 'yugi');
  same(['MrBeast +', 'MrBeast Side', 'MrBeast + Diddy', 'MrBeast + DEV'], 'mrbeast');
  same(['cap', 'cap side', 'cap side2', 'cap farm', 'cap3'], 'cap');
  same(['Kev', 'Kev10', 'Kev Side', 'KEV'], 'kev');
  same(['quANT +', 'quANT Side2', 'quANT3'], 'quant');
  assert.notEqual(entityKey('Chinese Gake'), entityKey('Gake'));
  assert.equal(entityKey('67 +'), '67');
  assert.equal(entityKey('100xDan Side2'), '100xdan');
  assert.equal(entityKey('TB6'), 'tb6');
});

test('Parsed Events: рента и обёртка WSOL через токен-аккаунты относятся к владельцу', async () => {
  const { tokenAccountsOf } = await import('../server/providers/helius.ts');
  const p = {
    tokenTransfers: [{ fromTokenAccount: 'TA1', fromUserAccount: 'W', toTokenAccount: 'TB1', toUserAccount: 'X' }],
    instructions: [
      { programName: 'token_2022', instructionName: 'close_account', decoded: { accounts: [{ name: 'account', pubkey: 'TA2' }, { name: 'destination', pubkey: 'W' }, { name: 'owner', pubkey: 'W' }] } },
      { programName: 'associated_token_account', instructionName: 'create_idempotent', decoded: { accounts: [{ name: 'funding_account', pubkey: 'W' }, { name: 'associated_token_account', pubkey: 'TB2' }, { name: 'wallet_owner', pubkey: 'Y' }] } },
      { programName: 'token', instructionName: 'sync_native', decoded: { accounts: [{ name: 'account', pubkey: 'WS' }] } },
      { programName: 'token', instructionName: 'sync_native', decoded: { accounts: [{ name: 'account', pubkey: 'TA1' }] } },
    ],
  };
  const { owners, unknown } = tokenAccountsOf(p);
  assert.equal(owners.get('TA1'), 'W');
  assert.equal(owners.get('TA2'), 'W', 'возврат ренты при закрытии — перевод самому себе');
  assert.equal(owners.get('TB2'), 'Y', 'рента нового ATA — перевод владельцу ATA');
  assert.ok(unknown.has('WS') && !unknown.has('TA1'));
});
