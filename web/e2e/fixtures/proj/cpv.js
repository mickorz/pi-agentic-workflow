export const meta = { name: "cpv_demo", description: "verify + checkpoint + agent" };
const v = await verify("1+1=2")
const ok = await checkpoint("允许继续吗？")
const r = await agent("after-cp")
return { real: v.real, ok, r }
