# Deo - Local AI Coding Agent

**Deo** is an autonomous, privacy-first AI coding agent that runs directly inside VS Code. Powered by your local Ollama models (defaulting to `qwen2.5:latest`), Deo performs multi-step coding tasks, edits files, and manages your workspace without sending code to the cloud.

## Features

- **🤖 Autonomous Agent Loop**: Give Deo a high-level task (e.g., "Create a React component for a login form"), and it will plan, create folders, write files, and edit code iteratively.
- **🔒 100% Local & Private**: Connects to your local Ollama instance. Your code never leaves your machine.
- **💬 Modern Chat Interface**: A clean, dedicated chat panel with Markdown support, code highlighting, and streaming responses.
- **⚡ Smart Actions**:
  - `create_folder`: Automatically structures your project.
  - `create_file`: Generates new source files.
  - `edit_file`: Modifies existing code in place.
  - `insert_code`: Inserts snippets directly at your cursor.
- **🛡️ Safe Execution**: Strictly sandboxed to your current workspace root.

## Prerequisites

1. **Install Ollama**: Download from [ollama.com](https://ollama.com).
2. **Pull the Model**: Deo is optimized for `qwen2.5`. Run this in your terminal:
   ```bash
   ollama pull qwen2.5
   ```
3. **Start Ollama**: Ensure Ollama is running (`ollama serve`).

## Usage

1. Open VS Code.
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
3. Run **"Ask Deo AI"**.
4. The **Deo Chat** panel will open.
5. Ask a question or give a task!
   - *Example: "Create a src/utils folder and add a logger.ts file with a basic logging class."*
   - *Example: "Explain the selected code."*

## Extension Settings

Currently, Deo connects to `http://127.0.0.1:11434` by default. Future versions will allow configuration of the model and host.

## Known Issues

- Requires a powerful local machine for best performance (depending on the model size).
- Markdown streaming can occasionally be jittery with very long responses.

## Release Notes

### 0.0.1
- Initial release of Deo.
- Local Ollama `qwen2.5` integration.
- Multi-step agentic capabilities (Create/Edit/Insert).
- Streaming chat interface.

---

**Enjoy coding with your local AI pair programmer!**
