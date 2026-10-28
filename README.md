# yakumo-rolldown

Rolldown support for [Yakumo](https://github.com/cordiverse/yakumo).

A drop-in replacement for `yakumo-esbuild` that bundles workspace packages with
[rolldown](https://rolldown.rs) instead of esbuild. Declaration (`.d.ts`) files
are produced by `yakumo-tsc`, not this plugin.

## Install

```sh
yarn add -D @dingyi222666/yakumo-rolldown rolldown yakumo yakumo-tsc
```

## Usage

Register it in `yakumo.yml` like any other yakumo plugin:

```yaml
- name: yakumo
  config:
    pipeline:
      build:
        - tsc
        - rolldown
- name: yakumo-tsc
- name: "@dingyi222666/yakumo-rolldown"
```

Then:

```sh
yakumo rolldown              # bundle all located workspaces
yakumo rolldown foo          # bundle one package
yakumo rolldown --minify     # minify output
```

`build` in this README pipelines `tsc` (types) then `rolldown` (JS), matching
the yakumo-tsc → yakumo-rolldown split of responsibilities.

## Notes

- Entry points and output formats are inferred from `package.json`
  (`main` / `module` / `exports` / `bin`), same contract as `yakumo-esbuild`.
- `dependencies` / `peerDependencies` / `optionalDependencies` stay external;
  `devDependencies` are bundled; an import not listed anywhere fails the build.
- `.yml` / `.yaml` imports are loaded as JSON. `bin` entries get a Node hashbang.
