import { Context, PackageJson } from "yakumo";
import { load, TsConfig } from "tsconfig-utils";
import { rolldown } from "rolldown";
import type { InputOptions, OutputOptions, Plugin } from "rolldown";
import type {} from "@cordisjs/plugin-cli";
import z from "schemastery";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { isBuiltin } from "node:module";
import * as fs from "node:fs/promises";
import * as yaml from "js-yaml";
import { globby } from "globby";

/** Rolldown build request: input options plus the output block split out at build time. */
interface BuildRequest extends InputOptions {
  output: OutputOptions;
}

declare module "yakumo" {
  interface Events {
    "yakumo/rolldown"(
      path: string,
      options: BuildRequest,
      next: () => Promise<void>,
    ): Promise<void>;
  }
}

export const inject = ["yakumo", "cli"];

export interface Config {
  minify: boolean;
}

export const Config: z<Config> = z.object({
  minify: z.boolean(),
});

const DependencyType = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function yamlPlugin(): Plugin {
  return {
    name: "yaml",
    load: {
      filter: { id: /\.ya?ml$/ },
      handler: async (id) => {
        const source = await fs.readFile(id, "utf8");
        return {
          code: `export default ${JSON.stringify(yaml.load(source))}`,
          moduleType: "js",
        };
      },
    },
  };
}

function hashbangPlugin(binaries: string[]): Plugin {
  return {
    name: "hashbang",
    load: {
      filter: { id: /\.tsx?$/ },
      handler: async (id) => {
        if (!binaries.includes(id)) return null;
        let contents = await fs.readFile(id, "utf8");
        if (!contents.startsWith("#!")) {
          contents = "#!/usr/bin/env node\n" + contents;
        }
        return { code: contents };
      },
    },
  };
}

interface ExternalPluginOptions {
  manifest: PackageJson;
  exports: Record<string, Record<string, string>>;
  currentEntry: string;
  format: string;
}

function externalPlugin({
  manifest,
  exports,
  currentEntry,
  format,
}: ExternalPluginOptions): Plugin {
  return {
    name: "external library",
    resolveId: {
      filter: { id: [/^[@\w].+$/, /^\./] },
      handler: async function (id, importer, extraOptions) {
        if (/^[@\w]/.test(id)) {
          // bare specifier
          if (isAbsolute(id)) return null;
          if (isBuiltin(id)) return { id, external: true };
          const name = id.startsWith("@") ? id.split("/", 2).join("/") : id.split("/", 1)[0];
          if (name === manifest.name) return { id, external: true };
          const types = new Set(DependencyType.filter((type) => manifest[type]?.[name]));
          if (types.size === 0) {
            throw new Error(`Missing dependency: ${name} from ${importer}`);
          }
          types.delete("devDependencies");
          return { id, external: types.size > 0 };
        }
        // relative import
        const resolved = await this.resolve(id, importer, { skipSelf: true, ...extraOptions });
        const path = resolved?.id;
        const ext = extname(id);
        if (!path && ext.endsWith("js")) {
          const base = join(dirname(importer || ""), id.slice(0, -ext.length));
          const entry = exports[base + ".d" + ext.replace(/js$/, "ts")];
          if (entry) return { id: entry.types, external: true };
        }
        if (currentEntry === path || !path || !exports[path]) return null;
        if (format === "cjs") return { id: path, external: true };
        const outFile = exports[path].node || exports[path].default;
        if (!outFile) return null;
        const outDir = dirname(exports[currentEntry].node || exports[currentEntry].default);
        let relpath = relative(outDir, outFile).replace(/\\/g, "/");
        if (!relpath.startsWith(".")) relpath = "./" + relpath;
        return { id: relpath, external: true };
      },
    },
    load: {
      filter: { id: /\.d\.ts$/ },
      handler: async (id) => {
        const contents = await fs.readFile(id);
        return { code: contents.toString(), moduleType: "asset" };
      },
    },
  };
}

async function buildPackage(
  cwd: string,
  manifest: PackageJson,
  tsconfig: TsConfig,
  config: { minify?: boolean },
  buildCallback?: (
    options: BuildRequest,
    callback: (opts: BuildRequest) => Promise<void>,
  ) => Promise<void>,
) {
  const {
    rootDir = "",
    outFile,
    noEmit,
    emitDeclarationOnly,
    sourceMap,
  } = tsconfig.compilerOptions;
  if (!noEmit && !emitDeclarationOnly) return;
  const outDir = tsconfig.compilerOptions.outDir ?? dirname(outFile);
  const outdir = resolve(cwd, outDir);
  const outbase = resolve(cwd, rootDir);
  const matrix: BuildRequest[] = [];
  const exports: Record<string, Record<string, string>> = Object.create(null);
  const outFiles = new Set<string>();
  const binaries: string[] = [];
  const resolveCache: Record<string, any> = Object.create(null);

  async function resolvePattern(pattern: string) {
    if (!pattern.startsWith(outDir + "/")) {
      pattern = pattern.replace("*", "**");
      const targets = await globby(pattern, { cwd });
      for (const target of targets) {
        if (!relative(rootDir, target).startsWith("../")) continue;
        const filename = join(cwd, target);
        exports[filename] = { default: filename };
      }
      return;
    }
    const outExt = extname(pattern);
    pattern = pattern.slice(outDir.length + 1, -outExt.length).replace("*", "**") + ".{ts,tsx}";
    return [outExt, await globby(pattern, { cwd: outbase })] as const;
  }

  async function addExport(
    pattern: string | undefined,
    preset: any,
    prefix = "",
    isBinary = false,
  ) {
    if (!pattern) return;
    if (pattern.startsWith("./")) pattern = pattern.slice(2);
    const result = await (resolveCache[pattern] ??= resolvePattern(pattern));
    if (!result) return;
    const [outExt, targets] = result;
    preset = { ...preset };
    if (outExt === ".cjs") preset.format = "cjs";
    else if (outExt === ".mjs") preset.format = "esm";
    for (const target of targets) {
      const srcFile = join(cwd, rootDir, target);
      if (isBinary) binaries.push(srcFile);
      const srcExt = extname(target);
      const entry = target.slice(0, -srcExt.length);
      const outFile = join(outdir, entry + outExt);
      if (outFiles.has(outFile)) return;
      outFiles.add(outFile);
      if (!preset.platform) {
        (exports[srcFile] ||= {}).types = `${manifest.name}/${prefix}`;
      } else {
        (exports[srcFile] ||= {})[preset.platform] = outFile;
      }
      matrix.push({
        input: { [entry]: srcFile },
        plugins: [
          yamlPlugin(),
          externalPlugin({ manifest, exports, currentEntry: srcFile, format: preset.format }),
          hashbangPlugin(binaries),
        ],
        output: {
          dir: outdir,
          format: preset.format,
          entryFileNames: entry + outExt,
          minify: config.minify,
          sourcemap: sourceMap,
        },
        tsconfig: join(cwd, "tsconfig.json"),
        resolve: { extensions: [".tsx", ".ts", ".jsx", ".js", ".css", ".json"] },
      });
    }
  }

  function addConditionalExport(pattern: any, preset: any, prefix = "") {
    if (typeof pattern === "string") {
      return addExport(pattern, preset, prefix);
    }
    for (const key in pattern) {
      if (key === "require")
        addConditionalExport(pattern[key], { ...preset, format: "cjs" }, prefix);
      else if (key === "import")
        addConditionalExport(pattern[key], { ...preset, format: "esm" }, prefix);
      else if (["browser", "node"].includes(key))
        addConditionalExport(pattern[key], { ...preset, platform: key }, prefix);
      else if (["types", "typings"].includes(key))
        addConditionalExport(pattern[key], { ...preset, platform: undefined }, prefix);
      else
        addConditionalExport(
          pattern[key],
          preset,
          key.startsWith(".") ? join(prefix, key) : prefix,
        );
    }
  }

  const preset = {
    platform: "node",
    format: manifest.type === "module" ? "esm" : "cjs",
  };
  const tasks: Promise<void>[] = [];
  tasks.push(addExport(manifest.main, preset));
  tasks.push(addExport(manifest.module, { ...preset, format: "esm" }));
  addConditionalExport(manifest.exports, preset);
  if (!manifest.exports) {
    tasks.push(addExport("package.json", preset, ""));
  }
  if (typeof manifest.bin === "string") {
    tasks.push(addExport(manifest.bin, preset, "", true));
  } else if (manifest.bin) {
    for (const key in manifest.bin) {
      tasks.push(addExport(manifest.bin[key], preset, "", true));
    }
  }
  await Promise.all(tasks);

  const build =
    buildCallback ??
    ((options: BuildRequest, callback: (opts: BuildRequest) => Promise<void>) => callback(options));
  await Promise.all(
    matrix.map(async (options) => {
      try {
        await build(options, async (opts) => {
          const { plugins, output, ...rest } = opts;
          const bundle = await rolldown({ ...rest, plugins } as InputOptions);
          await bundle.write(output as OutputOptions);
          await bundle.close();
        });
      } catch (error) {
        console.error(error);
      }
    }),
  );
}

export function apply(ctx: Context, config: Config) {
  ctx.cli
    .command("rolldown [...packages]", "Build packages with rolldown")
    .option("--minify", "Minify output")
    .action(async ({ args, options }) => {
      await ctx.yakumo.initialize();
      const paths = ctx.yakumo.locate(args);
      await Promise.all(
        paths.map(async (path) => {
          const cwd = ctx.yakumo.cwd + path;
          const tsconfig = await load(cwd).catch(() => null);
          if (!tsconfig) return;
          await buildPackage(
            cwd,
            ctx.yakumo.workspaces[path],
            tsconfig,
            {
              minify: options.minify ?? config.minify,
            },
            async (options, callback) => {
              await ctx.waterfall("yakumo/rolldown", path, options, async () => {
                await callback(options);
              });
            },
          );
        }),
      );
    });
}
