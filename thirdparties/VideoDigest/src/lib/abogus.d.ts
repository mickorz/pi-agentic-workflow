// @moonr/abogus 无类型声明的 CJS 包，手写最小声明（default 形式导入）
declare module '@moonr/abogus' {
  const abogus: {
    /** 生成抖音 a_bogus 签名参数（与 UA 绑定），输入为不含签名的查询串 */
    generate_a_bogus(urlSearchParams: string, userAgent: string): string;
  };
  export default abogus;
}
