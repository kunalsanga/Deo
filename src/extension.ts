import * as vscode from 'vscode';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "deo" is now active!');

	const disposable = vscode.commands.registerCommand('deo.askAI', () => {
		const panel = vscode.window.createWebviewPanel(
			'deoChat',
			'Deo Chat',
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'node_modules'))]
			}
		);

		panel.webview.html = getWebviewContent(context);

		panel.webview.onDidReceiveMessage(
			async (message) => {
				switch (message.command) {
					case 'sendMessage':
						const userPrompt = message.text;
						const { TextDecoder } = require('util');

						// Iteration state
						const MAX_STEPS = 15;
						let stepCount = 0;
						let conversationHistory = `You are an autonomous coding agent. 
You must decide the next action to perform the user's request.
Available actions:
- create_folder: { "action": "create_folder", "path": "path/to/folder" }
- create_file: { "action": "create_file", "path": "path/to/file", "content": "file content" }
- edit_file: { "action": "edit_file", "path": "path/to/file", "content": "new complete content" }
- insert_code: { "action": "insert_code", "content": "code snippet" } (Use this to answer questions or write to active editor)
- done: { "action": "done" } (Use this when the task is complete)

You must return ONLY a strict JSON object for the action. No markdown. No explanations.
User Request: ${userPrompt}
`;

						try {
							panel.webview.postMessage({ command: 'receiveMessage', text: 'Thinking...', isStreaming: false });

							while (stepCount < MAX_STEPS) {
								stepCount++;
								let fullAiResponse = "";

								// 1. Send Request to Ollama
								const response = await fetch('http://127.0.0.1:11434/api/generate', {
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({
										model: "qwen2.5:latest",
										prompt: conversationHistory,
										stream: true,
										format: "json"
									})
								});

								if (!response.body) throw new Error("No response body");

								const reader = response.body.getReader();
								const decoder = new TextDecoder();
								let buffer = "";

								while (true) {
									const { done, value } = await reader.read();
									if (done) break;
									const chunk = decoder.decode(value, { stream: true });
									buffer += chunk;
									const lines = buffer.split('\n');
									buffer = lines.pop() || "";
									for (const line of lines) {
										if (!line.trim()) continue;
										try {
											const json = JSON.parse(line);
											if (json.response) fullAiResponse += json.response;
										} catch (e) { console.error(e); }
									}
								}

								// 2. Parse Action
								let actionData;
								try {
									// Clean potential markdown wrappers
									const cleanJson = fullAiResponse.replace(/```json/g, '').replace(/```/g, '').trim();
									actionData = JSON.parse(cleanJson);
								} catch (e) {
									console.error("JSON Parse Error:", fullAiResponse);
									conversationHistory += `\nSystem: Invalid JSON returned. Please retry with valid JSON format.`;
									continue;
								}

								// 3. Execute Action
								const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
								let executionResult = "";

								if (actionData.action === 'done') {
									panel.webview.postMessage({ command: 'receiveMessage', text: "✅ Task Completed.", isStreaming: false });
									return;
								}

								if (['create_file', 'edit_file', 'create_folder'].includes(actionData.action)) {
									if (!workspaceFolder) throw new Error("No workspace open.");
									if (!actionData.path) throw new Error("No path provided.");

									const targetPath = path.join(workspaceFolder, actionData.path);

									// Safety Check
									if (!targetPath.startsWith(workspaceFolder)) {
										executionResult = "Error: Access denied. Cannot write outside workspace.";
									} else {
										try {
											if (actionData.action === 'create_folder') {
												fs.mkdirSync(targetPath, { recursive: true });
												executionResult = `Success: Created folder ${actionData.path}`;
											} else {
												const dirPath = path.dirname(targetPath);
												if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
												fs.writeFileSync(targetPath, actionData.content || "");
												executionResult = `Success: Wrote to ${actionData.path}`;
											}
										} catch (err: any) {
											executionResult = `Error: ${err.message}`;
										}
									}

									// Notify UI of progress
									panel.webview.postMessage({ command: 'receiveMessage', text: `🛠 ${executionResult}`, isStreaming: false });

								} else if (actionData.action === 'insert_code') {
									const editor = vscode.window.visibleTextEditors[0];
									if (editor) {
										await editor.edit(editBuilder => {
											editBuilder.insert(editor.selection.active, actionData.content);
										});
										executionResult = "Success: Code inserted.";
										panel.webview.postMessage({ command: 'receiveMessage', text: "✅ Code inserted.", isStreaming: false });
									} else {
										executionResult = "Error: No visible editor.";
										panel.webview.postMessage({ command: 'receiveMessage', text: "⚠ No visible editor.", isStreaming: false });
									}
								} else {
									executionResult = `Error: Unknown action ${actionData.action}`;
								}

								// 4. Update History for Next Iteration
								conversationHistory += `\nAssistant Action: ${JSON.stringify(actionData)}\nSystem Result: ${executionResult}\n`;
							}

							panel.webview.postMessage({ command: 'receiveMessage', text: "⚠ Max steps reached.", isStreaming: false });

						} catch (error: any) {
							const errorMessage = `Error: ${error.message}`;
							panel.webview.postMessage({ command: 'receiveMessage', text: errorMessage, isStreaming: false });
							console.error(error);
						}
						return;
				}
			},
			undefined,
			context.subscriptions
		);
	});

	context.subscriptions.push(disposable);
}

function getWebviewContent(context: vscode.ExtensionContext) {
	// Read marked.js from node_modules
	const markedPath = path.join(context.extensionPath, 'node_modules', 'marked', 'lib', 'marked.umd.js');
	let markedJs = '';
	try {
		markedJs = fs.readFileSync(markedPath, 'utf8');
	} catch (e) {
		console.error('Could not read marked.js', e);
	}

	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Deo Chat</title>
    <style>
        :root {
            --gap: 12px;
            --radius-L: 16px;
            --radius-S: 8px;
        }
        body {
            font-family: var(--vscode-font-family);
            margin: 0;
            padding: 0;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        
        /* Chat Area */
        .chat-container {
            flex: 1;
            padding: 20px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 20px;
        }

        /* Message Bubbles */
        .message {
            max-width: 85%;
            padding: 12px 16px;
            font-size: 14px;
            line-height: 1.5;
            animation: fadeIn 0.3s ease-in-out;
            position: relative;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .user {
            align-self: flex-end;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-radius: var(--radius-L) var(--radius-L) 2px var(--radius-L);
        }

        .ai {
            align-self: flex-start;
            background-color: var(--vscode-editor-lineHighlightBackground); /* Subtle contrast */
            border: 1px solid var(--vscode-widget-border);
            border-radius: var(--radius-L) var(--radius-L) var(--radius-L) 2px;
        }

        .system {
            align-self: center;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }

        /* Input Area */
        .input-area {
            padding: 16px;
            background-color: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-panel-border);
            display: flex;
            gap: 10px;
            align-items: center;
        }

        textarea {
            flex: 1;
            padding: 10px;
            border-radius: var(--radius-S);
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: inherit;
            resize: none;
            outline: none;
            height: 40px; /* Initial height */
            min-height: 40px;
            max-height: 150px;
        }

        textarea:focus {
            border-color: var(--vscode-focusBorder);
        }

        button {
            padding: 10px 20px;
            border-radius: var(--radius-S);
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            cursor: pointer;
            font-weight: 500;
            transition: opacity 0.2s;
            height: 42px;
        }

        button:hover {
            opacity: 0.9;
        }

        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        /* Markdown & Code Blocks */
        code {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.9em;
            background-color: rgba(127, 127, 127, 0.1);
            padding: 2px 4px;
            border-radius: 4px;
        }

        pre {
            background-color: var(--vscode-textBlockQuote-background);
            padding: 12px;
            border-radius: 8px;
            overflow-x: auto;
            margin: 10px 0;
            border: 1px solid var(--vscode-widget-border);
        }

        pre code {
            background-color: transparent;
            padding: 0;
        }

        p { margin: 0 0 10px 0; }
        p:last-child { margin-bottom: 0; }

        /* Scrollbar */
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
    </style>
</head>
<body>
    <div class="chat-container" id="chatContainer">
        <div class="message ai">Hello! I'm Deo. How can I help you code today?</div>
    </div>
    
    <div class="input-area">
        <textarea id="messageInput" placeholder="Type a message..." rows="1"></textarea>
        <button id="sendBtn">Send</button>
    </div>

    <!-- Inject Marked.js -->
    <script>
        ${markedJs}
    </script>

    <script>
        const vscode = acquireVsCodeApi();
        const chatContainer = document.getElementById('chatContainer');
        const messageInput = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');

        let isGenerating = false;

        // Auto-resize textarea
        messageInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight) + 'px';
        });

        function addMessage(text, sender) {
            const div = document.createElement('div');
            div.className = 'message ' + sender;
            
            if (sender === 'ai') {
                try {
                    div.innerHTML = marked.parse(text);
                } catch (e) {
                    div.textContent = text;
                }
            } else {
                div.textContent = text;
            }
            
            chatContainer.appendChild(div);
            scrollToBottom();
            return div;
        }

        function scrollToBottom() {
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        function setGenerating(state) {
            isGenerating = state;
            sendBtn.disabled = state;
            messageInput.disabled = state;
            if (state) {
                sendBtn.textContent = '...';
            } else {
                sendBtn.textContent = 'Send';
                messageInput.focus();
            }
        }

        function sendMessage() {
            const text = messageInput.value.trim();
            if (text && !isGenerating) {
                addMessage(text, 'user');
                vscode.postMessage({ command: 'sendMessage', text: text });
                
                messageInput.value = '';
                messageInput.style.height = '40px'; // Reset height
                setGenerating(true);
            }
        }

        sendBtn.addEventListener('click', sendMessage);

        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'receiveMessage') {
                if (message.text === 'Thinking...') {
                     // Temporary placeholder handling if needed, 
                     // or just handled by UI state. Use a system message or similar?
                     // For now, let's just ignore "Thinking..." text as a message bubble 
                     // unless specific indicator desired.
                     // But the backend sends "Thinking..." as a distinct message.
                     // Let's display it as a system status or transient message.
                     const statusDiv = document.createElement('div');
                     statusDiv.className = 'system';
                     statusDiv.id = 'temp-thinking';
                     statusDiv.textContent = 'Deo is thinking...';
                     chatContainer.appendChild(statusDiv);
                     scrollToBottom();
                     return;
                }

                // Remove temp status if exists
                const temp = document.getElementById('temp-thinking');
                if (temp) temp.remove();

                addMessage(message.text, 'ai');
                setGenerating(false);
            } 
            // Note: streamToken is not used in non-streaming mode UI currently, 
            // but if re-enabled in backend, logic would go here.
        });
    </script>
</body>
</html>`;
}

export function deactivate() { }
