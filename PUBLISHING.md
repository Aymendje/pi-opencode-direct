# Publishing

## First release

The package name is `pi-opencode-direct`. It was not listed on npm when checked
on 2026-09-10; availability is not reserved until publication.

Repository, homepage, and issue links point to
https://github.com/Aymendje/pi-opencode-direct. Keep `pi.extensions` and the
`pi-package` keyword:
[Pi's gallery](https://pi.dev/docs/latest/packages) discovers npm packages by
that keyword. No compiled build is needed; Pi loads the shipped TypeScript.

From the repository root:

```sh
npm ci --ignore-scripts
npm run verify
npm pack --dry-run
```

The tarball should contain only `package.json`, `src/index.ts`,
`src/provider.ts`, `README.md`, `CHANGELOG.md`, and `LICENSE`. Tests, CI,
node_modules, and local settings are excluded. The Pi packages are peers;
npm installs them as peers during package installation. Do not omit peer
dependencies: the native transport subpath imports need them even though Pi
also supplies its core extension API.

Commit and push the reviewed release, then authenticate with the npm account
that will own the package and publish:

```sh
npm login
npm publish --access public
```

`prepublishOnly` runs the verification checks again. CI only verifies changes;
it does not publish. After publication, verify a clean Pi installation with:

```sh
pi install npm:pi-opencode-direct
```

Select **OpenCode Zen Free** in `/model`. Allow time for the Pi gallery to index
the npm package.

## Later releases

Update `CHANGELOG.md`, bump the package version with
`npm version patch --no-git-tag-version` (or `minor` / `major`), and update both
User-Agent version strings in `src/provider.ts`. Run verification, review and
commit the release, then publish. Each npm version can only be published once.

Live verification is optional: `npm run test:live` sends two real free-tier
requests. Regular verification uses fixtures and needs no model credentials.
