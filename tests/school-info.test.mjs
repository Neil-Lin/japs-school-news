import test from 'node:test';
import assert from 'node:assert/strict';
import {openingAnnouncements} from '../school-info-ui.mjs';

test('opening notices use all local-school news, with recent dates and no claims about active closures', () => {
  const now = Date.parse('2026-11-18T04:00:00Z');
  const make = (title, published = '2026-11-17T00:00:00Z', url = 'https://www.japs.tp.edu.tw/news') => ({title, published, url});
  const items = [
    make('校園暫停開放，請確認原文日期'),
    make('校園場地開放規則', '2026-11-16T00:00:00Z'),
    make('操場施工', '2026-11-15T00:00:00Z'),
    make('遊戲場開放資訊', '2026-11-14T00:00:00Z'),
    make('校園開放', '2026-01-01T00:00:00Z'),
    make('校園開放', '2026-11-19T00:00:00Z'),
    make('校園開放', 'not a date'),
    make('校園開放', undefined, 'https://www.doe.gov.taipei/news'),
    make('校園開放', undefined, 'https://www.japs.tp.edu.tw.evil.test/news'),
    make('校園開放', undefined, 'javascript:alert(1)'),
    make('圖書館場地開放申請'),
  ];
  assert.deepEqual(openingAnnouncements(items, 'https://www.japs.tp.edu.tw', now), items.slice(0, 3));
});
