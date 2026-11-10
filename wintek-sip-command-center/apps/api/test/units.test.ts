import { csvCell, parseCsv, parseCsvObjects } from '../src/modules/atms/csv';
import { redact } from '../src/common/http/redact';
import { atmSipUsername, generateSipPassword, sipHa1 } from '../src/modules/atms/sip-identity.service';
import { q850ToSip } from '../src/modules/calls/sip/sip-driver';
import { hashPassword, passwordPolicyError, verifyPassword } from '../src/modules/auth/password';
import { SqlWhere } from '../src/common/db/sql-where';

describe('csv', () => {
  it('parses quotes, escaped quotes, CRLF and BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
  });
  it('maps header names case-insensitively', () => {
    expect(parseCsvObjects('ATM_Code,Name\nA1,First\n').records).toEqual([{ atm_code: 'A1', name: 'First' }]);
  });
  it('neutralises formula injection on export', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('plain')).toBe('plain');
  });
});

describe('redact', () => {
  it('removes secrets at any depth', () => {
    expect(redact({ a: 1, password: 'p', nested: { sipPassword: 'x', token: 't', list: [{ ha1: 'h' }] } })).toEqual({
      a: 1, password: '[REDACTED]', nested: { sipPassword: '[REDACTED]', token: '[REDACTED]', list: [{ ha1: '[REDACTED]' }] },
    });
  });
});

describe('sip credentials', () => {
  it('computes RFC 2617 HA1', () => {
    const { createHash } = require('node:crypto');
    expect(sipHa1('alice', 'example.com', 'secret')).toBe(createHash('md5').update('alice:example.com:secret').digest('hex'));
    expect(sipHa1('a', 'r', 'p')).toMatch(/^[0-9a-f]{32}$/);
  });
  it('generates unambiguous 24-char passwords', () => {
    const p = generateSipPassword();
    expect(p).toHaveLength(24);
    expect(p).not.toMatch(/[01IlO]/);
    expect(new Set(Array.from({ length: 50 }, () => generateSipPassword())).size).toBe(50);
  });
  it('derives device usernames', () => {
    expect(atmSipUsername('ATM-MH_001')).toBe('atm-mh-001');
    expect(atmSipUsername('BR7-0042')).toBe('atm-br7-0042');
  });
});

describe('q850 -> SIP', () => {
  it('maps common causes', () => {
    expect(q850ToSip(17)).toBe(486);
    expect(q850ToSip(19)).toBe(480);
    expect(q850ToSip(16)).toBe(200);
    expect(q850ToSip(null)).toBeNull();
  });
});

describe('passwords', () => {
  it('hashes and verifies with scrypt', async () => {
    const h = await hashPassword('Correct-Horse-9');
    expect(await verifyPassword('Correct-Horse-9', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
  it('enforces the policy', () => {
    expect(passwordPolicyError('short')).toMatch(/12/);
    expect(passwordPolicyError('alllowercaseletters')).toMatch(/three/);
    expect(passwordPolicyError('Wintek#Demo2026')).toBeNull();
  });
});

describe('SqlWhere', () => {
  it('numbers placeholders across fragments', () => {
    const w = new SqlWhere().add('a = ?', 1).add('(b = ? OR c = ?)', 2, 3);
    expect(w.sql).toBe('WHERE a = $1 AND (b = $2 OR c = $3)');
    expect(w.params).toEqual([1, 2, 3]);
  });
});
