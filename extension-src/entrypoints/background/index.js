export default defineBackground({
  type: "module",
  main() {
    void import("./runtime.js");
  },
});
