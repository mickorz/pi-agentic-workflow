A)  
页1: APPROVED — 封面标题、要点、强调条完整清晰，无贴边，风格统一。  
页2: APPROVED — 标题层级正确，正文与强调条内容匹配原文，排版无溢出重叠。  
页3: APPROVED — 标题、正文、强调条准确对应要求，留白得当，无缺字。  
页4: APPROVED — 示意图清晰完整，图注与图中元素（HOME REPO、AGENTS.md指针、克隆箭头等）一致，关键路径与文件名可辨。  
页5: APPROVED — 四步清单编号、标题、注释均完整，无错漏，排版规整。  
页6: APPROVED — 标题、正文、强调条内容完整，技术细节（如~/repos/acme/storefront、remote克隆等）准确无缺字。  
页7: APPROVED — 引文与来源链接完整，引号、换行、小字说明均合规，无贴边。

B)  
页1文字转录：封面 · COVER  
一个仓库  
指挥所有仓库  
Home Repo 模式 · Matt Pocock  
SKILLS 一个家 AGENTS.MD 带指针 会话从这里启动  

页2文字转录：你的 AI 只看得见 一个仓库  
skills 每仓一份  
跨仓规划无全景  
项目一拆成多个仓库，AI 编码助手的视野就塌了：agent 从哪个仓库启动，就只看见哪个仓库。skills 和代理配置每个仓库各养一份，改一处要同步 N 处；规划一个横跨仓库的功能，没有任何会话能看到全景。Matt Pocock 在 AI Hero 提出解法：Home Repo，一个专门指挥其他仓库的主仓库。  

页3文字转录：一个仓库 当指挥台  
三样家当  
三重收益  
Home Repo 装三样东西：跨仓库通用的 skills、写满指针的 AGENTS.md、共享文档——编码规范是最值得共享的第一份文档。收益也是三个：指挥文件和工具有个家，所有 agent 会话从这里启动，一次会话就能横扫多个仓库。代码留在原仓库，历史、remote、issue tracker 一概不动。  

页4文字转录：实证 · EVIDENCE  
一图看懂  
Home Repo  
AGENT SESSION  
会话从这里启动，跨仓规划在这里  
启动  
↓  
HOME REPO  
acme/home 主仓库  
skills/  
AGENTS.md  
docs/  
↓  
AGENTS.md 指针  
↓ ↓ ↓  
电商前台        支付 API        管理后台        + 20 MORE  
acme/           acme/           acme/admin-     几百个仓库时  
storefront      payments-api    dashboard      一域一文件  
克隆  
↓  
POINTER EXAMPLE  
Storefront (Next.js app):  
~/repos/acme/storefront  
代码留在原仓库，历史 remote 不动  

页5文字转录：清单 · CHECKLIST  
四步搭起来  
01 盘点仓库  
路径 remote 提交时间  
02 共享物归桶  
共享重复单仓已装  
03 方案先过目  
去向表你点头才动  
04 分支上执行  
子仓删副本可回滚  

页6文字转录：指针怎么写 规模怎么扛  
20 个平铺  
几百个分组  
指针一行一仓库：Storefront（Next.js 应用）：  
~/repos/acme/storefront，缺了就按 remote 克隆，需要时加一句提示  
——改它之前先读它的 AGENTS.md。约 20 个仓库平铺指针就够；到几百个，按业务域分组，一个域一个文件，渐进披露；上千个就该做 skills 市场了。子模块在 5~10 个仓库时也行，但普通指针同效还省事。  

页7文字转录：“  
用户目录是权宜  
版本化仓库才是家  
原文附可复制 SETUP PROMPT · AIHERO.DEV/THE-HOME-REPO-PATTERN