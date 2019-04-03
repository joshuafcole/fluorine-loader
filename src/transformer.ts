import md5 = require("md5-jkmyers");
import MagicString from "magic-string";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import {
  MemberExpression,
  Identifier,
  CallExpression,
  Literal,
  ObjectExpression,
  Node
} from "estree";
import { RawSourceMap } from "source-map";
import { inline_chunk } from "efreet/utils";

let now = Date.now; // Curse you, webpack...

type Times = { [name: string]: number };

interface VisitorState {
  root: acorn.Node;
  time: Times;
  code: MagicString;
}

//----------------------------------------------------------------------
// Public API
//----------------------------------------------------------------------
export interface Options {
  sourcemap?: boolean;
  now?: () => number;
}

export async function transform(input: string, opts: Options = {}) {
  if (opts.now) now = opts.now;
  let time_start = now();
  let root = acorn.parse(input);

  let state: VisitorState = {
    root,
    time: {
      start: time_start,
      parse: now(),
      visit: 0,
      md5: 0,
      transform_element: 0,
      transform_catalyst: 0
    },
    code: new MagicString(input)
  };

  walk.ancestor(root, visitors, undefined, state);
  let { time, code } = state;
  time.walk = now();

  return {
    code: code.toString(),
    sourcemap: opts.sourcemap
      ? ((code.generateMap({
          includeContent: true
        }) as unknown) as RawSourceMap)
      : undefined,
    performance: time
  };
}

//----------------------------------------------------------------------
// Transformations
//----------------------------------------------------------------------

let visitors = {
  CallExpression(
    node: acorn.Node & CallExpression,
    state: VisitorState,
    ancestors: (acorn.Node & Node)[]
  ) {
    let { time, code } = state;
    let time_visit_start = now();
    if (is_react_create_element_call(node))
      transform_react_create_element(node, state, ancestors);
    if (is_catalyst_handler(node))
      transform_catalyst_handler(node, state, ancestors);
    time.visit += now() - time_visit_start;
  }
};

//----------------------------------------------------------------------
// Transform React create element
//----------------------------------------------------------------------

function is_react_create_element_call(node: acorn.Node & CallExpression) {
  let callee = node.callee as (MemberExpression | Identifier);
  if (callee.type === "Identifier") return false;
  if ((callee.property as Identifier).name !== "createElement") return false;
  if (callee.object.type !== "Identifier") return false;
  if ((callee.object as Identifier).name !== "React") return false;
  return true;
}

function transform_react_create_element(
  node: acorn.Node & CallExpression,
  state: VisitorState,
  ancestors: (acorn.Node & Node)[]
) {
  let { time, code } = state;
  let time_transform_element_start = now();
  let [tagname_node, props_node, ...children_nodes] = node.arguments as [
    (Literal | Identifier) & acorn.Node,
    (ObjectExpression | Literal) & acorn.Node,
    ...acorn.Node[]
  ];

  let props_str = "";
  let props: string[] = [];
  if (props_node.type === "ObjectExpression") {
    props_str = code.slice(props_node.start + 1, props_node.end - 1);
    for (let { key } of props_node.properties) {
      // @NOTE: We could make this even faster by adding an init step and separating static properties out.
      if (key.type === "Identifier") props.push(key.name);
      else if (key.type === "Literal") props.push("" + key.value);
      else throw new Error(`Unknown key type: '${key.type}'`);
    }
  }

  let children = "";
  if (children_nodes.length) {
    children = code.slice(
      children_nodes[0].start,
      children_nodes[children_nodes.length - 1].end
    );
  }
  let time_md5_start = now();
  let kind = props.length ? md5(props.join("__")) : "static";
  time.md5 += now() - time_md5_start;

  if (tagname_node.type === "Literal") {
    let tagname = tagname_node.value;

    let elem_str = `kind: "${kind}"`;
    if (tagname) elem_str += `, tagname: "${tagname}"`;
    if (props_str) elem_str += `, ${props_str}`;
    if (children) elem_str += `, children: [\n${children}\n]`;
    code.overwrite(node.start, node.end, `{${elem_str}}`);
    // specializations[kind] = props;
    if (kind !== "static" && kind !== "text" && kind !== "default") {
      code.appendLeft(
        ancestors[1].start,
        inline_chunk`
        React.renderer.specialize("${kind}", ${JSON.stringify(
          props
        )}); // Auto-generated Fluorine specialization.
      ` + "\n"
      );
    }
  } else {
    let elem_str = `{${props_str}`;
    if (children)
      elem_str += `${
        elem_str.length > 1 ? ", " : ""
      }children: [\n${children}\n]`;
    code.overwrite(node.start, node.end, `${tagname_node.name}(${elem_str}})`);
  }
  time.transform_element += now() - time_transform_element_start;
}

//----------------------------------------------------------------------
// Transform Catalyst handler
//----------------------------------------------------------------------

function is_catalyst_handler(node: acorn.Node & CallExpression) {
  return (
    node.callee.type === "MemberExpression" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "handle" &&
    node.callee.object.type === "Identifier" &&
    (node.callee.object.name === "catalyst_1" ||
      node.callee.object.name === "fluorine_1")
  );
}
let catalyst_handler_methods = {
  stop: true,
  stop_if: true,
  prevent: true,
  prevent_if: true,
  when: true,
  then: true
};

function transform_catalyst_handler(
  node: acorn.Node & CallExpression,
  state: VisitorState,
  ancestors: (acorn.Node & Node)[]
) {
  let { time, code } = state;
  let time_transform_catalyst_start = now();
  let ix = ancestors.length - 2;
  while (ix > 0) {
    let parent = ancestors[ix];
    if (!parent) break;
    if (parent.type !== "MemberExpression") break;
    if (!catalyst_handler_methods[(parent.property as Identifier).name]) break;
    if (!ancestors[ix - 1] || ancestors[ix - 1].type !== "CallExpression")
      break;
    ix -= 2;
  }
  ix += 1;
  let outer = ancestors[ix];
  let handler_code = code.slice(outer.start, outer.end);

  let time_md5_start = now();

  let key = md5(handler_code);
  time.md5 += now() - time_md5_start;

  // @FIXME: Gotta check if these guys are function references (relocatable) or not before doing this :(
  //         Swapping to a memo-ized version with the key baked in should be a universally safe fallback.
  code.appendLeft(
    ancestors[1].start,
    inline_chunk`
    React.handlers["${key}"] = ${handler_code}.compile(); // Auto-generated Catalyst compiled handler.
  ` + "\n"
  );
  code.overwrite(outer.start, outer.end, `React.handlers["${key}"]`);

  time.transform_catalyst += now() - time_transform_catalyst_start;
}
