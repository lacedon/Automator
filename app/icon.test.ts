import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

const appDir = path.resolve(__dirname);

test('app icon assets are present and non-empty', () => {
  for (const file of ['icon.svg', 'favicon.ico', 'apple-icon.png']) {
    expect(fs.statSync(path.join(appDir, file)).size).toBeGreaterThan(0);
  }
});

test('icon.svg is an SVG with a viewBox', () => {
  const svg = fs.readFileSync(path.join(appDir, 'icon.svg'), 'utf8');
  expect(svg.trimStart()).toMatch(/^<svg[\s>]/);
  expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
  expect(svg.trimEnd()).toMatch(/<\/svg>$/);
});

test('favicon.ico is a valid icon container with 16, 32 and 48px entries', () => {
  const ico = fs.readFileSync(path.join(appDir, 'favicon.ico'));
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  const count = ico.readUInt16LE(4);
  const sizes = Array.from({ length: count }, (_, i) => ico[6 + i * 16]);
  expect(sizes.sort((a, b) => a - b)).toEqual([16, 32, 48]);
});

test('apple-icon.png is a 180px PNG', () => {
  const png = fs.readFileSync(path.join(appDir, 'apple-icon.png'));
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(180);
  expect(png.readUInt32BE(20)).toBe(180);
});
