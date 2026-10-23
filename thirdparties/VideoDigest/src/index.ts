#!/usr/bin/env node
import { createCli } from '@clibase/core';
import { profile } from './profile.js';
import { commands } from './commands/index.js';

// 极薄入口 只装配 profile 与命令数组 加命令永不碰本文件
createCli({ profile, commands }).run();
