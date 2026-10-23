import { helloCommand } from './hello.js';
import { askCommand } from './ask.js';
import { digestCommand } from './digest.js';
import { noteCommand } from './note.js';
import { downloadCommand } from './download.js';
import { srtCommand } from './srt.js';
import { douyinUserCommand } from './douyinUser.js';
import { cookieCommand } from './cookie.js';

/**
 * 命令注册表 桶文件
 * 新增命令 在本目录建 xxx ts 导出后 加入此数组 无需改 src index ts
 */
export const commands = [helloCommand, askCommand, digestCommand, noteCommand, downloadCommand, srtCommand, douyinUserCommand, cookieCommand];
