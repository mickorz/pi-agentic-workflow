export const meta = {
  name: "xss_demo",
  description: "<img src=x onerror='window.__xss=(window.__xss||0)+1'> payload",
}
phase("p")
log("<script>window.__xss=(window.__xss||0)+10</script>")
const approved = await checkpoint("<b>bold</b> 批准？<img src=x onerror='window.__xss=(window.__xss||0)+100'>")
return { approved }
