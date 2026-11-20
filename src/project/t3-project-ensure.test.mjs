// 委派前确保 cwd 已注册为 T3 项目：t3 thread start <cwd> 只接受
// 已注册项目（或项目内路径），未注册时 CLI 报 "No T3 Code project matches"。
// 这里覆盖纯判定面：projectCovers / needsRegister；注册执行 ensureT3Project。

import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCovers, needsRegister } from './t3-project-ensure.js';

const P = ['/Users/w/code/web', '/Users/w/docs'];

test('projectCovers: cwd 等于已注册项目 → 覆盖', () => {
  assert.equal(projectCovers(P, '/Users/w/code/web'), true);
});

test('projectCovers: cwd 在已注册项目内（子目录）→ 覆盖', () => {
  assert.equal(projectCovers(P, '/Users/w/code/web/src'), true);
});

test('projectCovers: cwd 是已注册项目的父目录 → 也算覆盖（项目在 cwd 内）', () => {
  assert.equal(projectCovers(P, '/Users/w/code'), true);
});

test('projectCovers: 无关路径 → 不覆盖', () => {
  assert.equal(projectCovers(P, '/Users/w/other'), false);
  assert.equal(projectCovers(P, '/Users/w/code/we'), false); // 前缀非目录边界
});

test('projectCovers: 尾斜杠与空值归一化', () => {
  assert.equal(projectCovers(['/Users/w/code/web/'], '/Users/w/code/web'), true);
  assert.equal(projectCovers(P, ''), false);
  assert.equal(projectCovers([], '/x'), false);
});

test('needsRegister: 与 projectCovers 互补', () => {
  assert.equal(needsRegister(P, '/Users/w/feishu'), true);
  assert.equal(needsRegister(P, '/Users/w/docs/子'), false);
});
