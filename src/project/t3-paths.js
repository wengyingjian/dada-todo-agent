// T3 Code 本地资源路径（无项目内依赖，供 reverse-sync / delegate / runtime 共用）
import os from 'node:os';
import path from 'node:path';

export function t3Home() {
  return process.env.T3CODE_HOME || path.join(os.homedir(), '.t3');
}

export function t3DbPath() {
  return path.join(t3Home(), 'userdata', 'statev2.sqlite');
}
