import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackageVersion } from '@clibase/core';
import type { CliProfile } from '@clibase/core';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 身份配置 版本号运行时从 package.json 读取 单一真相源 */
export const profile: CliProfile = {
  name: 'vcli',
  displayName: 'Vcli',
  description: 'Vcli 命令行工具',
  version: readPackageVersion(path.resolve(here, '..')),
};
