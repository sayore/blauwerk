# Arch Linux Package

Build and install Blauwerk through pacman:

```bash
cd packaging/arch
makepkg -si
```

The package builds a native standalone executable from the tagged source
release. Bun is required only while building the package; the installed
`/usr/bin/blauwerk` binary does not need Bun at runtime.

The compatibility alias is installed as `/usr/bin/bt-matrix`.
