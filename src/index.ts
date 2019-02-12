import {getOptions} from "loader-utils";
import {performance} from "perf_hooks";

import {transform} from "@joshuafcole/fluorine";
import { RawSourceMap } from "source-map";
import sorcery = require("source-map");
import { loader } from "webpack";

let now = performance.now;

export interface Options {
  benchmark?:boolean,
  sourceMap?:boolean,
  _filename?:string
}

function fluorine_loader(this:loader.LoaderContext, source:string|Buffer, last_sourcemap:RawSourceMap|undefined) {
  let opts:Options = getOptions(this) || {};
  if(opts.sourceMap === undefined) opts.sourceMap = this.sourceMap;
  opts._filename = this.resource;

  let callback = this.async()!;
  _async_loader(source, last_sourcemap, opts).then(([code, sourcemap]) => {
    callback(null, code, sourcemap as any);
  }).catch((err) => {
    callback(err);
  });

  return undefined;
}

export default fluorine_loader;


async function _async_loader(source:string|Buffer, last_sourcemap:RawSourceMap|undefined, opts:Options = {}):Promise<[string, RawSourceMap?]> {
  let {code, sourcemap: next_sourcemap, performance:time} =
    await transform(source instanceof Buffer ? source.toString() : source, {sourcemap: opts.sourceMap, now});

  if(next_sourcemap) {
    let merged_sourcemap = next_sourcemap;

    if(last_sourcemap) {
      next_sourcemap.file = last_sourcemap.file;
      next_sourcemap.sourceRoot = last_sourcemap.sourceRoot;

      let source_gen = sorcery.SourceMapGenerator.fromSourceMap(await new sorcery.SourceMapConsumer(next_sourcemap));
      source_gen.applySourceMap(await new sorcery.SourceMapConsumer(last_sourcemap));
      merged_sourcemap = source_gen.toJSON();
    }

    time.sourcemap = now();
    if(opts.benchmark) show_performance(time, opts);
    return [code, merged_sourcemap];

  } else {
    if(opts.benchmark) show_performance(time, opts);
    return [code];
  }
}

function show_performance(time:{[key:string]: number}, opts:Options = {}) {
  console.log("  Fluorine Loader transformed", opts._filename, "in", i((time.sourcemap !== undefined ? time.sourcemap : time.walk) - time.start) + "ms");
  console.log(`
    - parse ..................${h(time.parse - time.start)}ms
    - walk ...................${h(time.walk - time.parse)}ms
      - visit ................${h(time.visit)}ms
        - transform_element ..${h(time.transform_element)}ms
        - transform_catalyst .${h(time.transform_catalyst)}ms
      - md5 ..................${h(time.md5)}ms
    ${time.sourcemap !== undefined ? `- sourcemap ..............${h(time.sourcemap - time.walk)}ms` : ""}
  `.slice(1, -1));
}

function h(num:number) {
  let prefix = "";
  for(let ix = 0; ix < 3 - (""+Math.floor(num)).length; ix += 1) prefix += ".";
  return prefix + " " + i(num);
}

function i(num:number) {
  if(Math.floor(num) == num) return ""+num;
  else return num.toFixed(3);
}
