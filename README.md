# VSCode Workspaces Extension

![GitHub License](https://img.shields.io/github/license/ZanzyTHEbar/vscode-workspaces)
<!-- [![Lint](https://github.com/ZanzyTHEbar/vscode-workspaces/actions/workflows/eslint.yml/badge.svg)](https://github.com/ZanzyTHEbar/vscode-workspaces/actions/workflows/eslint.yml) -->
![GNOME Extensions download](https://img.shields.io/badge/-vscode--workspaces--gnome-blue?logo=gnome&logoColor=white&colorA=252525&colorB=blue)

## Description

<!-- ![screenshot.png](screenshot.png) -->

VSCode Workspaces is a project that provides a GNOME Shell extension for accessing visual studio code/codium recently opened workspaces/directories.

With workspace support, you can open a workspace in Visual Studio Code with a single click.

## Features

- Supports GNOME Shell 45+
- List all your local VSCode workspaces
- List all your remote VSCode projects
- Add a custom workspace by path
- Supports both Visual Studio Code and Codium
- Optional Nautilus extensions for opening folders and files in Visual Studio Code

## Install Extension

### Install from GNOME Extensions

[<img alt="" height="100" src="https://raw.githubusercontent.com/andyholmes/gnome-shell-extensions-badge/master/get-it-on-ego.svg?sanitize=true">](https://extensions.gnome.org/extension/7117/)

### Install from Source

```bash
bash <(wget -qO- https://raw.githubusercontent.com/ZanzyTHEbar/vscode-workspaces/main/install.sh)
```

## Usage

### GNOME Shell Extension

To open a recent folder or workspace, click on the Visual Studio Code icon in the top bar and select a recent folder or workspace.

You also have various options to configure the extension in the GNOME Tweaks application.

Integrates well with the [VSCode Search Provider](https://extensions.gnome.org/extension/6976/vscode-search-provider/).

#### Uninstall GNOME Shell Extension

To uninstall a GNOME Shell extension, you can use the GNOME Tweaks application or the `gnome-extensions` command.

```bash
gnome-extensions disable vscode-workspaces@prometheontechnologies.com
gnome-extensions uninstall vscode-workspaces@prometheontechnologies.com
```

You can also remove the directory manually.

```bash
rm -rf ~/.local/share/gnome-shell/extensions/vscode-workspaces@prometheontechnologies.com
```

### Nautilus Extensions

Provided are two other, optional, extensions for Nautilus.

The first, `vscode_nautilus_workspaces.py`, adds a right-click context menu to select from a list of recently accessed workspaces or directories and open in Visual Studio Code.

The second, `vscode_nautilus_open.py`, adds a right-click context menu to open a folder or file in Visual Studio Code.

To open a folder or file in Visual Studio Code, right-click on an item in Nautilus and select the "Open in Code" option.

To open a recent folder or workspace, right-click on an empty space in Nautilus and select the "Open Recent Workspaces" option.

#### Uninstall Nautilus Extensions

```bash
rm -f ~/.local/share/nautilus-python/extensions/vscode_nautilus_workspaces.py
rm -f ~/.local/share/nautilus-python/extensions/vscode_nautilus_open.py
```

## Development

The latest development version requires `git`, `node`, and `make`.

I use `pnpm`, but you can use `npm` or `yarn` if you prefer. It is up to you to modify the scripts to use your preferred package manager.

Navigate to your desired directory and execute following commands in the terminal:

### GNOME 45+

```bash
git clone https://github.com/ZanzyTHEbar/vscode-workspaces.git
cd vscode-workspaces/gnome-extension

make && make install
```

You can run `make help` to see all available commands.

### Dev Container

If you'd rather not install Node and pnpm on your machine, the repository ships a [Dev Container](https://containers.dev/) with the whole build toolchain (Node 20, pnpm 9, `glib-compile-schemas`, `zip`, `make`). You only need Docker and the VS Code [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) extension.

1. Open the repository in VS Code and run **Dev Containers: Reopen in Container**. Dependencies are installed automatically on first start.
2. In the container terminal, build the extension package:

    ```bash
    cd gnome-extension
    make pack
    ```

3. On the **host** (not in the container), install the generated zip:

    ```bash
    gnome-extensions install --force gnome-extension/vscode-workspaces.zip
    ```

`make install` copies the extension into the current user's GNOME extensions directory, so running it inside the container has no effect on your desktop. Use `make pack` in the container and `gnome-extensions install` on the host instead.

### Enabling the extension

After installation you need to enable the extension.

- First restart GNOME Shell (`ALt` + `F2`, `r`, `Enter`, or Log-Out/Log-In if you use Wayland)
- Now you should see the _VSCode W_ extension in the _Extensions_ application (reopen the app if needed to load new data), where you can enable it.

### Debugging

The GNOME Extension has a debug mode that is enabled by default. You can disable it by opening the settings of the extension in the GNOME Extensions application.

I personally use Extensions List, a GNOME Shell extension.

If you would like to see logs for this extension: `journalctl /usr/bin/gnome-shell -f | grep vscode-workspaces`.

Or simply run `journalctl /usr/bin/gnome-shell -f` and look for the logs.

### Contributing

If you'd like to contribute, please fork the repository and use a feature branch. Pull requests are warmly welcome :smile:
