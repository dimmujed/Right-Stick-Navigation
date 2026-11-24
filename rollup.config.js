import deckyPlugin from "@decky/rollup";
import ts from "typescript";

const config = deckyPlugin();
config.output.sourcemap = false;
config.treeshake.manualPureFunctions = ["console.warn", "console.error"];

config.plugins.push({
  name: "release-output",
  renderChunk(code) {
    const file = ts.createSourceFile("index.js", code, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);
    const printer = ts.createPrinter({ removeComments: true }, {
      substituteNode(_, node) {
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
            ["Error", "TypeError"].includes(node.expression.text) &&
            node.arguments?.length === 1 && ts.isStringLiteral(node.arguments[0])) {
          return ts.factory.updateNewExpression(node, node.expression, node.typeArguments, []);
        }
        return node;
      },
    });
    return printer.printFile(file);
  },
});

export default config;
