import { describe, expect, it } from '@jest/globals';
import { protectCsvValue, sanitizeFilename, sha256 } from './index';

describe('shared security helpers', () => {
  it.each(['=SUM(A1:A2)', '+value', '-value', '@value'])('protects a spreadsheet value', (value) => {
    expect(protectCsvValue(value)).toBe(`'${value}`);
  });
  it('preserves ordinary values', () => {
    expect(protectCsvValue('Quarterly report')).toBe('Quarterly report');
  });
  it('keeps only the final safe filename component', () => {
    expect(sanitizeFilename('../folder/report.txt')).toBe('report.txt');
    expect(sanitizeFilename('folder\\document.txt')).toBe('document.txt');
  });
  it('produces a deterministic digest', () => {
    expect(sha256('email')).toHaveLength(64);
    expect(sha256('email')).toBe(sha256('email'));
  });
});
