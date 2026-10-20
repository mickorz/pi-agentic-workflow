export const meta = {
  name: "deploy-service",
  description: "demo",
}
const result = await agent("Reply in one short sentence confirming the deploy-service workflow ran with args: " + JSON.stringify(args))
return result
