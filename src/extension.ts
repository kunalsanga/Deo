import * as vscode from 'vscode';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    console.log('Deo extension activated');

    const openChat = vscode.commands.registerCommand('deo.openChat', () => {
        openChatPanel(context);
    });
    context.subscriptions.push(openChat);

    const selectModelDisposable = vscode.commands.registerCommand('deo.selectModel', async () => {
        try {
            const response = await axios.get('http://127.0.0.1:11434/api/tags');
            if (response.status !== 200) {
                throw new Error(`Failed to fetch models: ${response.statusText}`);
            }
            const data = response.data;
            const modelNames = data.models.map((m: any) => m.name);

            const selected = await vscode.window.showQuickPick(modelNames, {
                placeHolder: 'Select a model for Deo'
            });

            if (selected) {
                await vscode.workspace.getConfiguration('deo').update('selectedModel', selected, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Deo model selected: ${selected}`);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error fetching models: ${error.message}`);
        }
    });

    context.subscriptions.push(selectModelDisposable);
}


function openChatPanel(context: vscode.ExtensionContext) {
    const panel = vscode.window.createWebviewPanel(
        'deoChat',
        'Deo Chat',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'node_modules'))]
        }
    );

    // Session Management
    let sessions = context.globalState.get<any[]>('deo.chatSessions', []);
    let activeSessionId = context.globalState.get<string>('deo.activeSessionId', '');

    const saveSessions = () => {
        context.globalState.update('deo.chatSessions', sessions);
        context.globalState.update('deo.activeSessionId', activeSessionId);
        // Notify UI
        panel.webview.postMessage({ command: 'updateSessionList', sessions, activeSessionId });
    };

    const createSession = () => {
        const id = Date.now().toString();
        const newSession = { id, title: 'New Chat', messages: [], timestamp: Date.now() };
        sessions.unshift(newSession);
        if (sessions.length > 20) { sessions.pop(); } // Max 20 sessions
        activeSessionId = id;
        saveSessions();
        return newSession;
    };

    // Ensure at least one session exists
    if (sessions.length === 0 || !activeSessionId) {
        createSession();
    }

    // Initial Load
    // 1. Set Webview Content FIRST to ensure script and listeners are active
    panel.webview.html = getWebviewContent(panel.webview, context);

    // 2. Determine Activate Session
    const activeSession = sessions.find(s => s.id === activeSessionId) || createSession();
    activeSessionId = activeSession.id;

    // 3. Fallback Initialization (in case webviewReady is missed)
    setTimeout(() => {
        console.log('Fallback init timeout fired');
        initWebviewData();
    }, 1000);

    // Function to update global history (Now updates active session)
    const updateHistory = (newItem: any) => {
        const session = sessions.find(s => s.id === activeSessionId);
        if (session) {
            session.messages.push(newItem);
            if (session.messages.length > 200) { session.messages.shift(); } // Max 200 messages

            // Auto-title on first user message
            if (newItem.type === 'user') {
                const userMsgs = session.messages.filter((m: any) => m.type === 'user');
                if (userMsgs.length === 1) {
                    const words = newItem.text.split(' ').slice(0, 5).join(' ');
                    session.title = words || 'New Chat';
                }
            }
            saveSessions();
        }
    };

    const initWebviewData = async () => {
        try {
            // A. Load Session
            const activeSession = sessions.find(s => s.id === activeSessionId) || createSession();
            activeSessionId = activeSession.id;

            panel.webview.postMessage({ command: 'loadSession', session: activeSession });
            panel.webview.postMessage({ command: 'updateSessionList', sessions, activeSessionId });

            // B. Load Models
            const currentModel = vscode.workspace.getConfiguration('deo').get<string>('selectedModel') || 'qwen2.5:latest';

            try {
                console.log('Fetching models with axios...');
                const response = await axios.get('http://127.0.0.1:11434/api/tags');
                if (response.status === 200) {
                    const data = response.data;
                    const models = data.models?.map((m: any) => m.name) || [];
                    console.log('Models fetched:', models.length);
                    panel.webview.postMessage({
                        command: 'loadModels',
                        models: models.length > 0 ? models : [currentModel],
                        selectedModel: currentModel
                    });
                } else {
                    console.error("Failed to fetch models: Response not OK");
                    panel.webview.postMessage({ command: 'loadModels', models: [currentModel], selectedModel: currentModel });
                }
            } catch (fetchError) {
                console.error("Error fetching models:", fetchError);
                panel.webview.postMessage({ command: 'loadModels', models: [currentModel], selectedModel: currentModel });
            }

        } catch (e) {
            console.error("Error in initialization:", e);
        }
    };

    panel.webview.onDidReceiveMessage(
        async (message) => {
            switch (message.command) {
                case 'webviewReady':
                    console.log('Webview Ready received. Initializing data...');
                    await initWebviewData();
                    return;
                case 'newChat':
                    const newSess = createSession();
                    panel.webview.postMessage({ command: 'loadSession', session: newSess });
                    return;
                case 'setModel':
                    try {
                        await vscode.workspace.getConfiguration('deo').update('selectedModel', message.model, vscode.ConfigurationTarget.Global);
                        panel.webview.postMessage({ command: 'modelUpdated', model: message.model });
                        vscode.window.showInformationMessage(`Deo model updated to: ${message.model}`);
                    } catch (e) {
                        vscode.window.showErrorMessage(`Failed to save model: ${e}`);
                    }
                    return;
                case 'loadChat':
                    activeSessionId = message.sessionId;
                    const sessToLoad = sessions.find(s => s.id === activeSessionId);
                    if (sessToLoad) {
                        saveSessions(); // Save active ID
                        panel.webview.postMessage({ command: 'loadSession', session: sessToLoad });
                    }
                    return;
                case 'sendMessage':
                    const userPrompt = message.text;
                    updateHistory({ type: 'user', text: userPrompt }); // Save user message

                    // ----------  Helper to un‑escape strings ----------
                    function decodeEscapes(str: string): string {
                        return str
                            .replace(/\\\\/g, '\\')
                            .replace(/\\n/g, '\n')
                            .replace(/\\r/g, '\r')
                            .replace(/\\t/g, '\t');
                    }

                    // Agent Logic Starts Here
                    const { TextDecoder } = require('util');

                    const systemPrompt = `You are an autonomous coding agent. 
You must create a comprehensive plan to fulfill the user's request using a sequence of actions.
Return ONLY a strict JSON ARRAY of actions. No markdown. No explanations.

**IMPORTANT RULES**
- If the user asks for more than one file (HTML + CSS, HTML + JS, etc.), emit a separate create_file action for each file.
- The value of the "content" property must contain real line‑break characters, NOT the escaped sequence "\\n".
- Do NOT wrap CSS in <style> tags and do NOT wrap JavaScript in <script> tags unless explicitly requested.
- Emit a create_folder action before any files that belong to that folder.
- Never concatenate the contents of different files into a single "content" string.

Available actions:
- create_folder: { "action": "create_folder", "path": "path/to/folder" }
- create_file:   { "action": "create_file",   "path": "path/to/file",   "content": "file content" }
- edit_file:     { "action": "edit_file",     "path": "path/to/file",   "content": "new complete content" }
- insert_code:   { "action": "insert_code",   "content": "code snippet" } (Use this to answer questions or write to the active editor)

Example Output:
[
  { "action": "create_folder", "path": "src/pages" },
  { "action": "create_file", "path": "src/pages/login.html", "content": "<!DOCTYPE html>\\n<html>\\n  …\\n</html>" },
  { "action": "create_file", "path": "src/pages/style.css", "content": "body {\\n  margin:0;\\n}\\n" }
]

User Request: ${userPrompt}
`;

                    try {
                        panel.webview.postMessage({ command: 'receiveMessage', text: 'Thinking...', isStreaming: false });

                        // Determine model to use
                        let selectedModel = vscode.workspace.getConfiguration('deo').get<string>('selectedModel');
                        if (!selectedModel) {
                            try {
                                const tagsResponse = await fetch('http://127.0.0.1:11434/api/tags');
                                if (tagsResponse.ok) {
                                    const tagsData = await tagsResponse.json() as any;
                                    if (tagsData?.models?.length > 0) {
                                        selectedModel = tagsData.models[0].name;
                                    }
                                }
                            } catch (e) {
                                console.error("Error fetching models for fallback:", e);
                            }
                        }
                        if (!selectedModel) {
                            selectedModel = "qwen2.5:latest";
                        }

                        // 1. Send Request to Ollama (Single Call)
                        let fullAiResponse = "";
                        const response = await fetch('http://127.0.0.1:11434/api/generate', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                model: selectedModel,
                                prompt: systemPrompt,
                                stream: true,
                                format: "json"
                            })
                        });

                        if (!response.body) { throw new Error("No response body"); }

                        const reader = response.body.getReader();
                        const decoder = new TextDecoder();
                        let buffer = "";

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) { break; }
                            const chunk = decoder.decode(value, { stream: true });
                            buffer += chunk;
                            const lines = buffer.split('\n');
                            buffer = lines.pop() || "";
                            for (const line of lines) {
                                if (!line.trim()) { continue; }
                                try {
                                    const json = JSON.parse(line);
                                    if (json.response) { fullAiResponse += json.response; }
                                } catch (e) { console.error(e); }
                            }
                        }

                        // 2. Parse Action Plan
                        let actionPlan: any[] = [];
                        try {
                            // Clean potential markdown wrappers
                            const cleanJson = fullAiResponse.replace(/```json/g, '').replace(/```/g, '').trim();
                            // Handle case where model might return a single object instead of array
                            const parsed = JSON.parse(cleanJson);
                            actionPlan = Array.isArray(parsed) ? parsed : [parsed];
                        } catch (e) {
                            console.error("JSON Parse Error:", fullAiResponse);
                            panel.webview.postMessage({ command: 'receiveMessage', text: "Error parsing agent plan. Please try again.", isStreaming: false });
                            updateHistory({ type: 'ai', text: "Error parsing agent plan." });
                            return;
                        }

                        // 3. Execute Actions Sequentially
                        const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;

                        panel.webview.postMessage({ command: 'receiveMessage', text: `📋 Executing ${actionPlan.length} steps...`, isStreaming: false });

                        for (const actionData of actionPlan) {
                            // Handle "done" if present
                            if (actionData.action === 'done') { continue; }

                            let executionResult = "";

                            if (['create_file', 'edit_file', 'create_folder'].includes(actionData.action)) {
                                if (!workspaceFolder) { throw new Error("No workspace open."); }
                                if (!actionData.path) { throw new Error("No path provided."); }

                                const targetPath = path.join(workspaceFolder, actionData.path);

                                // Safety Check
                                if (!targetPath.startsWith(workspaceFolder)) {
                                    executionResult = "Error: Access denied. Cannot write outside workspace.";
                                    panel.webview.postMessage({ command: 'receiveMessage', text: `⚠ ${executionResult}`, isStreaming: false });
                                } else {
                                    try {
                                        if (actionData.action === 'create_folder') {
                                            fs.mkdirSync(targetPath, { recursive: true });
                                            executionResult = `Success: Created folder ${actionData.path}`;
                                        } else {
                                            const dirPath = path.dirname(targetPath);
                                            if (!fs.existsSync(dirPath)) { fs.mkdirSync(dirPath, { recursive: true }); }

                                            // ----- Decode escaped new‑lines before writing -----
                                            const cleanContent = decodeEscapes(actionData.content || '');
                                            fs.writeFileSync(targetPath, cleanContent);
                                            executionResult = `Success: Wrote to ${actionData.path}`;
                                        }

                                        // Send Step Update Only on Success or actionable attempt
                                        const stepData = {
                                            command: 'agentStep',
                                            action: actionData.action,
                                            path: actionData.path
                                        };
                                        panel.webview.postMessage(stepData);
                                        updateHistory({ type: 'step', ...stepData });

                                    } catch (err: any) {
                                        executionResult = `Error: ${err.message}`;
                                        panel.webview.postMessage({ command: 'receiveMessage', text: `⚠ ${executionResult}`, isStreaming: false });
                                    }
                                }

                            } else if (actionData.action === 'insert_code') {
                                const editor = vscode.window.visibleTextEditors[0];
                                if (editor) {
                                    await editor.edit(editBuilder => {
                                        editBuilder.insert(editor.selection.active, actionData.content);
                                    });
                                    executionResult = "Success: Code inserted.";

                                    const stepData = {
                                        command: 'agentStep',
                                        action: 'insert_code',
                                        path: 'Active Editor'
                                    };
                                    panel.webview.postMessage(stepData);
                                    updateHistory({ type: 'step', ...stepData });

                                } else {
                                    executionResult = "Error: No visible editor.";
                                    panel.webview.postMessage({ command: 'receiveMessage', text: "⚠ No visible editor to insert code.", isStreaming: false });
                                }
                            }
                        }

                        panel.webview.postMessage({ command: 'receiveMessage', text: "✅ Task Completed.", isStreaming: false });
                        updateHistory({ type: 'ai', text: "✅ Task Completed." });

                    } catch (error: any) {
                        const errorMessage = `Error: ${error.message}`;
                        panel.webview.postMessage({ command: 'receiveMessage', text: errorMessage, isStreaming: false });
                        updateHistory({ type: 'ai', text: errorMessage });
                        console.error(error);
                    }
                    return;
            }
        },
        undefined,
    );
}

function getWebviewContent(webview: vscode.Webview, context: vscode.ExtensionContext) {
    // Read marked.js from node_modules and convert to Base64
    const markedPath = path.join(context.extensionPath, 'node_modules', 'marked', 'lib', 'marked.umd.js');
    let markedSrc = '';
    try {
        const markedContent = fs.readFileSync(markedPath, { encoding: 'base64' });
        markedSrc = `data:text/javascript;base64,${markedContent}`;
    } catch (e) {
        console.error('Could not read marked.js', e);
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src 'unsafe-inline' 'self';
                   script-src 'unsafe-inline' 'unsafe-eval' data:;
                   img-src data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Deo Chat</title>
    <style>
        :root {
            --gap: 12px;
            --radius: 6px;
            --font-family: var(--vscode-font-family);
            --bg-color: var(--vscode-editor-background);
            --fg-color: var(--vscode-editor-foreground);
            --sidebar-bg: var(--vscode-sideBar-background);
            --border-color: var(--vscode-panel-border);
        }
        body {
            font-family: var(--font-family);
            margin: 0;
            padding: 0;
            background-color: var(--bg-color);
            color: var(--fg-color);
            height: 100vh;
            display: flex;
            overflow: hidden;
        }

        /* --- Sidebar --- */
        .sidebar {
            width: 250px;
            background-color: var(--sidebar-bg);
            border-right: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            flex-shrink: 0;
            transition: width 0.3s ease;
            overflow: hidden;
        }
        .sidebar.collapsed { width: 0; border: none; }

        .sidebar-header {
            padding: 16px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .sidebar-header h2 { margin: 0; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.8; }

        .new-chat-btn {
            margin: 12px 16px;
            padding: 10px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: var(--radius);
            cursor: pointer;
            font-size: 13px;
            display: flex; align-items: center; justify-content: center; gap: 8px;
            font-weight: 500;
            transition: background 0.2s;
        }
        .new-chat-btn:hover { background-color: var(--vscode-button-hoverBackground); }

        .session-list {
            flex: 1;
            overflow-y: auto;
            padding: 0 8px;
        }

        .session-item {
            padding: 10px 12px;
            margin-bottom: 4px;
            cursor: pointer;
            border-radius: var(--radius);
            font-size: 13px;
            color: var(--fg-color);
            opacity: 0.8;
            display: flex; flex-direction: column; gap: 4px;
            transition: background 0.2s;
        }
        .session-item:hover { background-color: var(--vscode-list-hoverBackground); opacity: 1; }
        .session-item.active { background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); opacity: 1; }
        
        .session-title { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .session-time { font-size: 11px; opacity: 0.7; }

        /* --- Main Area --- */
        .main {
            flex: 1;
            display: flex;
            flex-direction: column;
            position: relative;
            background-color: var(--bg-color);
        }

        .top-bar {
            height: 48px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 16px;
            border-bottom: 1px solid var(--vscode-widget-border);
            background-color: var(--bg-color);
            z-index: 10;
        }
        .toggle-sidebar { 
            cursor: pointer; opacity: 0.7; padding: 6px; border-radius: 4px; display: flex; align-items: center; justify-content: center;
        }
        .toggle-sidebar:hover { background-color: var(--vscode-toolbar-hoverBackground); opacity: 1; }

        .chat-area {
            flex: 1;
            overflow-y: auto;
            padding: 24px;
            scroll-behavior: smooth;
            display: flex;
            flex-direction: column;
            gap: 20px;
        }

        /* --- Welcome/Empty State --- */
        .welcome-view {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            opacity: 0.8;
            text-align: center;
            user-select: none;
            margin-bottom: 100px; /* Offset for input */
        }
        .welcome-logo { font-size: 64px; margin-bottom: 16px; filter: drop-shadow(0 4px 6px rgba(0,0,0,0.2)); }
        .welcome-text h1 { margin: 0 0 8px 0; font-size: 28px; font-weight: 700; color: var(--vscode-foreground); }
        .welcome-text p { margin: 0; font-size: 15px; opacity: 0.7; max-width: 480px; line-height: 1.6; }

        /* --- Messages --- */
        .message-row {
            display: flex;
            gap: 16px;
            max-width: 800px;
            margin: 0 auto;
            width: 100%;
            animation: fadeIn 0.25s ease-out;
            position: relative;
        }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

        .avatar {
            width: 32px; height: 32px;
            border-radius: 6px;
            flex-shrink: 0;
            display: flex; align-items: center; justify-content: center;
            font-size: 18px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .avatar.ai { background: linear-gradient(135deg, #2196F3, #21CBF3); color: white; }
        .avatar.user { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }

        .message-content {
            flex: 1;
            min-width: 0;
            font-size: 14px;
            line-height: 1.6;
            margin-top: 4px; /* Align with avatar */
        }

        /* Sender Name */
        .sender-header {
            font-size: 12px;
            font-weight: 600;
            margin-bottom: 4px;
            opacity: 0.5;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        /* Markdown Styling */
        .markdown-body p { margin-top: 0; margin-bottom: 12px; }
        .markdown-body pre { 
            background-color: var(--vscode-textBlockQuote-background); 
            padding: 12px 16px; 
            border-radius: 6px; 
            overflow-x: auto; 
            border: 1px solid var(--vscode-widget-border);
            margin: 12px 0;
        }
        .markdown-body code { 
            font-family: var(--vscode-editor-font-family); 
            font-size: 13px; 
            background-color: rgba(127,127,127, 0.1); 
            padding: 2px 4px; 
            border-radius: 3px; 
        }
        .markdown-body pre code { background: none; padding: 0; }
        .markdown-body ul, .markdown-body ol { padding-left: 20px; }
        .markdown-body blockquote { 
            border-left: 4px solid var(--vscode-textBlockQuote-border); 
            background: rgba(127,127,127, 0.05);
            margin: 12px 0; 
            padding: 8px 16px; 
            border-radius: 0 4px 4px 0;
        }

        /* Agent Steps */
        .steps-container {
            margin-top: 12px;
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
            overflow: hidden;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
        }
        .steps-header {
            padding: 8px 12px;
            background-color: rgba(0,0,0,0.05);
            font-size: 12px;
            font-weight: 600;
            display: flex; align-items: center; gap: 8px;
            border-bottom: 1px solid rgba(0,0,0,0.05);
            color: var(--vscode-foreground);
        }
        .steps-list { padding: 0; }
        .step-item {
            padding: 8px 12px;
            font-size: 12px;
            display: flex; align-items: center; gap: 10px;
            border-bottom: 1px solid rgba(127,127,127, 0.1);
            background-color: var(--vscode-editor-background);
        }
        .step-item:last-child { border-bottom: none; }
        .step-icon { font-size: 14px; width: 16px; text-align: center; }
        .step-text { opacity: 0.9; word-break: break-word; font-family: var(--vscode-editor-font-family); }
        .spinner { animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }


        /* --- Input Area --- */
        .input-wrapper {
            padding: 24px;
            background: linear-gradient(to top, var(--bg-color) 85%, transparent);
            max-width: 800px;
            margin: 0 auto;
            width: 100%;
            box-sizing: border-box;
            position: sticky;
            bottom: 0;
            z-index: 100;
        }
        
        .input-box {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 10px;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            box-shadow: 0 8px 16px rgba(0,0,0,0.15);
            transition: border-color 0.2s, box-shadow 0.2s;
        }
        .input-box:focus-within {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 8px 24px rgba(0,0,0,0.25);
            transform: translateY(-1px);
        }

        textarea {
            width: 100%;
            border: none;
            background: transparent;
            color: var(--vscode-input-foreground);
            font-family: inherit;
            font-size: 14px;
            resize: none;
            outline: none;
            min-height: 24px;
            max-height: 250px;
            line-height: 1.5;
            padding: 0;
        }

        .input-footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-top: 1px solid rgba(127,127,127, 0.1);
            padding-top: 8px;
        }

        .model-selector {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            display: flex; align-items: center; gap: 4px;
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 4px;
            transition: background 0.2s;
            font-weight: 500;
            position: relative;
        }
        .model-selector:hover { background-color: var(--vscode-toolbar-hoverBackground); }
        
        .model-dropdown {
            position: absolute;
            bottom: 100%;
            left: 0;
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            z-index: 1000;
            max-height: 200px;
            overflow-y: auto;
            display: none;
            flex-direction: column;
            width: 200px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        .model-dropdown.show { display: flex; }
        .model-option {
            padding: 8px 12px;
            cursor: pointer;
            font-size: 12px;
        }
        .model-option:hover { background-color: var(--vscode-list-hoverBackground); }
        .model-option.selected { background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }

        .send-btn {
            background-color: var(--vscode-button-background);
            color: white;
            border: none;
            border-radius: 6px;
            width: 32px; height: 32px;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer;
            transition: all 0.2s;
        }
        .send-btn:hover { background-color: var(--vscode-button-hoverBackground); transform: scale(1.05); }
        .send-btn:active { transform: scale(0.95); }
        .send-btn svg { width: 16px; height: 16px; fill: currentColor; }

        /* Scrollbar */
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-thumb { background-color: var(--vscode-scrollbarSlider-background); border-radius: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
    </style>
</head>
<body>

    <div class="sidebar" id="sidebar">
        <div class="sidebar-header">
            <h2>History</h2>
        </div>
        <button class="new-chat-btn" id="newChatBtn">
            <span>+</span> New Chat
        </button>
        <div class="session-list" id="sessionList">
            <!-- Sessions injected here -->
        </div>
    </div>

    <div class="main">
        <div class="top-bar">
            <div class="toggle-sidebar" id="toggleSidebar" title="Toggle Sidebar">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
            </div>
            <div style="font-size: 12px; font-weight: 600; opacity: 0.6;">DEO AI</div>
        </div>

        <div class="chat-area" id="chatContainer">
            <div id="welcomeView" class="welcome-view">
                <div class="welcome-logo">⚡</div>
                <div class="welcome-text">
                    <h1>Deo</h1>
                    <p>Your intelligent coding companion.</p>
                </div>
            </div>
        </div>

        <div class="input-wrapper">
            <div class="input-box">
                <textarea id="messageInput" placeholder="How can I help you today?" rows="1"></textarea>
                <div class="input-footer">
                    <div class="model-selector" id="modelSelector">
                        <span id="currentModelDisplay">Loading...</span>
                        <span style="font-size: 8px;">▼</span>
                        <div class="model-dropdown" id="modelDropdown"></div>
                    </div>
                    <button class="send-btn" id="sendBtn" title="Send (Enter)">
                        <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                    </button>
                </div>
            </div>
        </div>
    </div>

    <!-- Marked JS -->
    <script src="${markedSrc}"></script>
    <script>
        console.log('Webview script starting...');
        if (typeof marked === 'undefined') {
            console.error('FAILED to load marked.js');
        } else {
            console.log('marked.js loaded successfully');
        }

        const vscode = acquireVsCodeApi();
        
        // --- Elements ---
        const chatContainer = document.getElementById('chatContainer');
        const welcomeView = document.getElementById('welcomeView');
        const messageInput = document.getElementById('messageInput');
        const modelSelector = document.getElementById('modelSelector');
        const currentModelDisplay = document.getElementById('currentModelDisplay');
        const modelDropdown = document.getElementById('modelDropdown');
        // const headerNewChat = document.getElementById('headerNewChat'); // ← removed (no such element)
        const sendBtn = document.getElementById('sendBtn');
        const sessionList = document.getElementById('sessionList');
        const newChatBtn = document.getElementById('newChatBtn');
        const sidebar = document.getElementById('sidebar');
        const toggleSidebar = document.getElementById('toggleSidebar');

        // --- State ---
        let isGenerating = false;
        let currentAgentPanel = null;
        let lastSender = null; // Track loose message grouping

        // --- Event Listeners ---
        messageInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight) + 'px';
        });

        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        sendBtn.addEventListener('click', sendMessage);

        // (New Chat button in sidebar handles this)

        modelSelector.addEventListener('click', (e) => {
             e.stopPropagation();
             modelDropdown.classList.toggle('show');
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', () => {
             modelDropdown.classList.remove('show');
        });

        // --- Model Selection Logic ---
        function renderModelList(models, selected) {
            modelDropdown.innerHTML = '';
            models.forEach(m => {
                const div = document.createElement('div');
                div.className = 'model-option ' + (m === selected ? 'selected' : '');
                div.textContent = m;
                div.onclick = (e) => {
                    e.stopPropagation();
                    vscode.postMessage({ command: 'setModel', model: m });
                    modelDropdown.classList.remove('show');
                    // Optimistic update
                    currentModelDisplay.textContent = m; 
                };
                modelDropdown.appendChild(div);
            });
            currentModelDisplay.textContent = selected || (models.length > 0 ? models[0] : 'No Model');
        }

        newChatBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'newChat' });
        });

        toggleSidebar.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
        });

        // --- Logic ---

        function renderHistoryList(sessions, activeId) {
            sessionList.innerHTML = '';

            sessions.forEach(sess => {
                const item = document.createElement('div');
                item.className = 'session-item' + (sess.id === activeId ? ' active' : '');

                const date = new Date(sess.timestamp);
                const today = new Date();
                const timeString = date.toDateString() === today.toDateString()
                    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : date.toLocaleDateString();

                // Build the inner HTML safely
                item.innerHTML = '<span class="session-title">' + (sess.title || 'New Chat') + '</span>' + 
                                '<span class="session-time">' + timeString + '</span>';

                // Clicking a session loads it
                item.addEventListener('click', () => {
                    vscode.postMessage({ command: 'loadChat', sessionId: sess.id });
                });

                sessionList.appendChild(item);
            });
        }

        function scrollToBottom() {
            // chatContainer.scrollTop = chatContainer.scrollHeight; 
            // Smooth scroll sometimes glitches if content is added fast, let's try normal scroll
            setTimeout(() => {
                if (chatContainer) chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
            }, 50);
        }

        function createMessageRow(sender) {
            const row = document.createElement('div');
            row.className = 'message-row ' + sender;

            const avatar = document.createElement('div');
            avatar.className = 'avatar ' + sender;
            avatar.innerText = sender === 'ai' ? '🤖' : '👤'; // Or use SVG icons

            // Container for content
            const contentWrapper = document.createElement('div');
            contentWrapper.style.flex = '1';
            contentWrapper.style.minWidth = '0';

            const name = document.createElement('div');
            name.className = 'sender-header';
            name.innerText = sender === 'ai' ? 'Deo' : 'You';
            
            contentWrapper.appendChild(name);

            if (sender === 'user') {
                // User on right? No, standard chat is left-all usually for assistants.
                // But let's stick to left-aligned with avatars as per modern design (ChatGPT/Claude).
                // It is already left aligned by CSS.
                row.appendChild(avatar);
                row.appendChild(contentWrapper);
            } else {
                row.appendChild(avatar);
                row.appendChild(contentWrapper);
            }

            chatContainer.appendChild(row);
            return contentWrapper;
        }

        function addMessage(text, sender, isHtml = false) {
            if (welcomeView) welcomeView.style.display = 'none';

            // Check if we can append to last message? 
            // For simplicity, always create new row for now, or new row if sender changed.
            const wrapper = createMessageRow(sender);
            
            const content = document.createElement('div');
            content.className = 'message-content markdown-body';
            
            if (sender === 'ai' || isHtml) {
                if (isHtml) content.innerHTML = text;
                else {
                    try { content.innerHTML = marked.parse(text); }
                    catch(e) { content.textContent = text; }
                }
            } else {
                content.textContent = text;
            }
            
            wrapper.appendChild(content);
            scrollToBottom();
            return content;
        }

        function sendMessage() {
            const text = messageInput.value.trim();
            if (text && !isGenerating) {
                addMessage(text, 'user');
                vscode.postMessage({ command: 'sendMessage', text: text });
                messageInput.value = '';
                messageInput.style.height = 'auto';
                isGenerating = true;
            }
        }

        // --- Agent Steps ---

        function startAgentPanel() {
            if (currentAgentPanel) return;
            if (welcomeView) welcomeView.style.display = 'none';

            const wrapper = createMessageRow('ai');
            
            const container = document.createElement('div');
            container.className = 'steps-container';
            container.innerHTML = \`
                <div class="agent-header">
                    <span class="spinner">⚙️</span>
                    <span>Thinking...</span>
                </div>
                <div class="steps-list"></div>
            \`;
            wrapper.appendChild(container);
            scrollToBottom();
            
            currentAgentPanel = container.querySelector('.steps-list');
        }

        function addAgentStep(step) {
            if (!currentAgentPanel) startAgentPanel();
            
            let icon = '🔹';
            let text = 'Processing...';
            
            if (step.action === 'create_folder') { icon = '📁'; text = 'Created folder: ' + step.path; }
            else if (step.action === 'create_file') { icon = '📄'; text = 'Created file: ' + step.path; }
            else if (step.action === 'edit_file') { icon = '✏️'; text = 'Edited file: ' + step.path; }
            else if (step.action === 'insert_code') { icon = '📝'; text = 'Inserted code'; }

            const div = document.createElement('div');
            div.className = 'step-item';
            div.innerHTML = \`<span class="step-icon">\${icon}</span><span class="step-text">\${text}</span>\`;
            
            currentAgentPanel.appendChild(div);
            scrollToBottom();
        }

        function completeAgentPanel(statusText) {
            if (!currentAgentPanel) return;
            
            // Update header to Done?
            const container = currentAgentPanel.parentElement;
            const header = container.querySelector('.agent-header');
            if (header) {
                header.innerHTML = '<span>✅ Task Completed</span>';
                header.style.backgroundColor = 'rgba(0, 255, 0, 0.1)';
            }
            currentAgentPanel = null;
        }
        
        function errorAgentPanel(errorText) {
            if (!currentAgentPanel) {
                addMessage('❌ ' + errorText, 'ai');
                return;
            }
            const container = currentAgentPanel.parentElement;
            const header = container.querySelector('.agent-header');
             if (header) {
                header.innerHTML = '<span>❌ Error</span>';
                header.style.color = 'var(--vscode-errorForeground)';
            }
            const div = document.createElement('div');
            div.className = 'step-item';
            div.style.color = 'var(--vscode-errorForeground)';
            div.innerText = errorText;
            currentAgentPanel.appendChild(div);
            
            currentAgentPanel = null;
        }


        // --- Message Handler ---
        window.addEventListener('message', event => {
            const message = event.data;
            // console.log('Webview received:', message.command);

            if (message.command === 'updateSessionList') {
                renderHistoryList(message.sessions, message.activeSessionId);
            }

            else if (message.command === 'loadSession') {
                chatContainer.innerHTML = '';
                chatContainer.appendChild(welcomeView);
                welcomeView.style.display = 'flex';
                
                currentAgentPanel = null;
                const session = message.session;
                
                if (session && session.messages && session.messages.length > 0) {
                    welcomeView.style.display = 'none';
                    session.messages.forEach(item => {
                         if (item.type === 'user') addMessage(item.text, 'user');
                         else if (item.type === 'ai') addMessage(item.text, 'ai');
                         else if (item.type === 'step') addAgentStep(item);
                    });
                }
                isGenerating = false;
            }

            else if (message.command === 'receiveMessage') {
                const text = message.text;

                if (text === 'Thinking...') { startAgentPanel(); return; }
                if (text.startsWith('🛠') || text.startsWith('Success:') || text === '✅ Code inserted.' || text === '⚠ No visible editor.') return; 

                if (text === '✅ Task Completed.') { completeAgentPanel('Task Completed'); isGenerating = false; return; }
                if (text === '⚠ Max steps reached.') { errorAgentPanel('Max steps reached'); isGenerating = false; return; }
                
                if (text.startsWith('Error:')) {
                    errorAgentPanel(text);
                    isGenerating = false;
                    return;
                }

                addMessage(text, 'ai');
                isGenerating = false;
            } 
            else if (message.command === 'agentStep') {
                addAgentStep(message);
            }
            else if (message.command === 'loadModels') {
                console.log('Received loadModels:', message);
                renderModelList(message.models, message.selectedModel);
                const display = document.getElementById('currentModelDisplay');
                if (display && message.selectedModel) {
                     display.textContent = message.selectedModel;
                }
            }
            else if (message.command === 'modelUpdated') {
                currentModelDisplay.textContent = message.model;
                // Re-render list to update selection highlight if we had full list access, 
                // but simpler just to update text for now or we could store models in state.
            }
        });
        
        // Notify extension that webview is ready
        setTimeout(() => {
            vscode.postMessage({ command: 'webviewReady' });
            console.log('Sent webviewReady');
        }, 100);
    </script>
</body>
</html>`;
}

export function deactivate() { }
