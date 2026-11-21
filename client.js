window.__ModuleLoader__.load({
	id: '@local/dsh-chat-work-tabs',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
        const { createPortal } = require('react-dom');
		const NS = 'chat-work-tabs';
		const MODE_KEY = 'dsh-chat-work-tabs.mode';
		const DEEP_KEY = 'dsh-chat-work-tabs.deepthink';
		const SMART_KEY = 'dsh-chat-work-tabs.smartsearch';

		const DICTS = [
			['zh', { chat: '聊天', work: '工作', deepthink: '深度思考', smartsearch: '智能搜索', history: '聊天', historyEmpty: '还没有网页版对话', historyLoading: '正在读取网页版记录…', historyError: '读取失败', historyClose: '关闭', historyBack: '返回列表', historyThinking: '深度思考', historySearch: '联网搜索', historyOpen: '在网页版继续' }],
			['zh-CN', { chat: '聊天', work: '工作', deepthink: '深度思考', smartsearch: '智能搜索', history: '聊天', historyEmpty: '还没有网页版对话', historyLoading: '正在读取网页版记录…', historyError: '读取失败', historyClose: '关闭', historyBack: '返回列表', historyThinking: '深度思考', historySearch: '联网搜索', historyOpen: '在网页版继续' }],
			['zh-Hans', { chat: '聊天', work: '工作', deepthink: '深度思考', smartsearch: '智能搜索', history: '聊天', historyEmpty: '还没有网页版对话', historyLoading: '正在读取网页版记录…', historyError: '读取失败', historyClose: '关闭', historyBack: '返回列表', historyThinking: '深度思考', historySearch: '联网搜索', historyOpen: '在网页版继续' }],
			['en', { chat: 'Chat', work: 'Work', deepthink: 'Deep thinking', smartsearch: 'Smart search', history: 'Chat', historyEmpty: 'No web conversations yet', historyLoading: 'Loading web history…', historyError: 'Could not load history', historyClose: 'Close', historyBack: 'Back to list', historyThinking: 'Deep thinking', historySearch: 'Web search', historyOpen: 'Open on the web' }],
			['en-US', { chat: 'Chat', work: 'Work', deepthink: 'Deep thinking', smartsearch: 'Smart search', history: 'Chat', historyEmpty: 'No web conversations yet', historyLoading: 'Loading web history…', historyError: 'Could not load history', historyClose: 'Close', historyBack: 'Back to list', historyThinking: 'Deep thinking', historySearch: 'Web search', historyOpen: 'Open on the web' }],
		];

		const BRIDGE = '/api/chat-work-tabs';
        const MAX_ATTACHMENTS = 8;
        const MAX_UPLOAD = 32 * 1024 * 1024;
        let bridgeToken;
        const bridgeLifetime = new AbortController();
        async function readBridgeJson(response) {
            try { return await response.json(); }
            catch { throw new Error('DSH 聊天服务返回了无效响应（HTTP ' + response.status + '）。'); }
        }
        function loadBridgeToken() {
            if (!bridgeToken) {
                bridgeToken = fetch(BRIDGE + '/bootstrap', {
                    headers: { 'x-dsh-chat-bootstrap': '1' }, cache: 'no-store', signal: bridgeLifetime.signal,
                }).then(async (response) => {
                    if (!response.ok) throw new Error('无法连接 DSH 聊天服务，请刷新后重试。');
                    const { token } = await readBridgeJson(response);
                    if (typeof token !== 'string' || !token) throw new Error('聊天认证响应无效。');
                    return token;
                }).catch((error) => { bridgeToken = null; throw error; });
            }
            return bridgeToken;
        }
        async function bridgeFetch(path, options = {}) {
            const signal = options.signal ? AbortSignal.any([options.signal, bridgeLifetime.signal]) : bridgeLifetime.signal;
            const send = (token) => fetch(BRIDGE + path, {
                ...options, signal, cache: 'no-store',
                headers: { ...options.headers, 'x-dsh-chat-token': token },
            });
            const pending = loadBridgeToken();
            const response = await send(await pending);
            if (response.status !== 401) return response;
            if (bridgeToken === pending) bridgeToken = null;
            return send(await loadBridgeToken());
        }

		const readStored = (key, fallback) => {
			try {
				const value = window.localStorage.getItem(key);
				return value === null || value === '' ? fallback : value;
			} catch {
				return fallback;
			}
		};

		const writeStored = (key, value) => {
			try {
				window.localStorage.setItem(key, value);
			} catch {
				// A blocked storage only affects the next mount, never this one.
			}
		};

		const readMode = () => {
			const mode = readStored(MODE_KEY, 'work');
			return mode === 'chat' || mode === 'work' ? mode : 'work';
		};
		const readFlag = (key) => readStored(key, 'off') === 'on';
		const readDeep = () => readFlag(DEEP_KEY);
		const readSmart = () => readFlag(SMART_KEY);

		/**
		 * The two switches are the whole selection surface, and they travel as the
		 * model's reasoning effort: the provider stays a single catalog entry, so
		 * Chat mode never adds rows to a model picker.
		 */
		const effortFor = (deep, smart) => {
			if (deep && smart) return 'think-search';
			if (deep) return 'think';
			if (smart) return 'search';
			return 'off';
		};

        // One resident switch in shell.overlay, shared by both empty states.
        // Its position follows the main column, rather than either composer.
        function ModeSwitcher({ translate }) {
            const state = useChat();
            const panel = React.useSyncExternalStore(
                (fn) => ctxRef.layout.panelInfo.subscribe(fn),
                () => ctxRef.layout.panelInfo.getSnapshot().activePanelId,
            );
            const [frame, setFrame] = React.useState(null);
            const [blankWork, setBlankWork] = React.useState(false);
            React.useLayoutEffect(() => {
                const main = document.querySelector('.mP3x-q_mainPanel');
                if (!main) return;
                const measure = () => {
                    const rect = main.getBoundingClientRect();
                    setFrame((old) => old && old.left === rect.left && old.top === rect.top && old.width === rect.width && old.height === rect.height ? old : { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
                    setBlankWork(Boolean(main.querySelector('[data-phase="hero"] .dsc-work-home-marker')));
                };
                const resize = new ResizeObserver(measure);
                const mutation = new MutationObserver(measure);
                resize.observe(main);
                mutation.observe(main, { childList: true, subtree: true });
                window.addEventListener('resize', measure);
                measure();
                return () => { resize.disconnect(); mutation.disconnect(); window.removeEventListener('resize', measure); };
            }, []);
            const mode = state.switching || (state.chatOpen ? 'chat' : 'work');
            const visible = panel === null && (state.switching || (state.chatOpen ? state.activeId === null : blankWork));
            if (!frame || !visible) return null;
            const text = (key, fallback) => { const value = translate(key); return value && value !== key ? value : fallback; };
            return h('div', {
                className: 'dsc-mode-overlay',
                style: { left: frame.left + frame.width / 2, top: frame.top + frame.height / 2 - 32 },
            }, h('div', { className: 'dsc-mode-switch', role: 'tablist', 'aria-label': '新会话模式', 'data-mode': mode }, [
                h('span', { key: 'thumb', className: 'dsc-mode-thumb', 'aria-hidden': true }),
                ...['chat', 'work'].map((entry) => h('button', {
                    key: entry, type: 'button', role: 'tab', 'aria-selected': entry === mode,
                    tabIndex: entry === mode ? 0 : -1, onClick: () => start(entry),
                    onKeyDown: (event) => {
                        const target = event.key === 'ArrowLeft' || event.key === 'Home' ? 'chat' : event.key === 'ArrowRight' || event.key === 'End' ? 'work' : null;
                        if (target) { event.preventDefault(); event.currentTarget.parentElement.querySelector(`[data-mode-tab="${target}"]`)?.focus(); start(target); }
                    },
                    'data-mode-tab': entry,
                }, text(entry, entry === 'chat' ? '聊天' : '工作'))),
            ]));
        }

		/**
		 * Web composer's two existing switches; they never select a Work model.
		 *
		 * There is no model to pick here — the provider is pinned — so the only
		 * decisions left are whether this turn thinks and whether it searches, and
		 * together they choose the adapter's reasoning effort for this web request.
		 */
		function ChatControls({ translate }) {
			const [deep, setDeep] = React.useState(readDeep);
			const [smart, setSmart] = React.useState(readSmart);


			const text = (key, fallback) => {
				let value;
				try {
					value = translate(key);
				} catch {
					value = key;
				}
				return typeof value === 'string' && value !== key ? value : fallback;
			};

			const commit = (nextDeep, nextSmart) => {
				setDeep(nextDeep);
				setSmart(nextSmart);
				writeStored(DEEP_KEY, nextDeep ? 'on' : 'off');
				writeStored(SMART_KEY, nextSmart ? 'on' : 'off');

			};

			const switchStyle = (on) => ({
				display: 'inline-flex',
				alignItems: 'center',
				gap: '6px',
				height: '26px',
				padding: '0 11px',
				borderRadius: '999px',
				cursor: 'pointer',
				fontFamily: 'inherit',
				fontSize: '12px',
				lineHeight: '1',
				color: on ? 'var(--dsw-alias-brand-primary, #df4a95)' : 'var(--dsw-alias-label-secondary)',
				background: on ? 'color-mix(in srgb, var(--dsw-alias-brand-primary, #df4a95) 9%, transparent)' : 'transparent',
				border: '1px solid ' + (on ? 'var(--dsw-alias-brand-primary, #df4a95)' : 'var(--dsw-alias-border-l1)'),
				transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
			});

			const dotStyle = (on) => ({
				width: '6px',
				height: '6px',
				borderRadius: '999px',
				background: on ? 'var(--dsw-alias-brand-primary, #df4a95)' : 'var(--dsw-alias-state-idle-primary)',
			});

			const switchButton = (key, label, on, toggle) => h('button', {
				key,
				type: 'button',
				onClick: toggle,
				title: label,
				'aria-pressed': on ? 'true' : 'false',
				style: switchStyle(on),
			}, [
				h('span', { key: 'dot', style: dotStyle(on) }),
				h('span', { key: 'text' }, label),
			]);

			return h('div', {
				style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
			}, [
				switchButton('deep', text('deepthink', '深度思考'), deep, () => commit(!deep, smart)),
				switchButton('smart', text('smartsearch', '智能搜索'), smart, () => commit(deep, !smart)),
			]);
		}

        const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        const LAST_ID = NS + '.lastWebSession';
        const LAST_PANEL = NS + '.lastPanel';
        const HISTORY_H_KEY = NS + '.historyHeight';
        /** Smallest useful history block, and the ceiling the operator can drag to. */
        const HISTORY_MIN = 120;
        const historyMax = () => Math.max(220, Math.min(window.innerHeight - 240, 900));
        const clampHistoryHeight = (value) => Math.max(HISTORY_MIN, Math.min(Math.round(value), historyMax()));
        const readHistoryHeight = () => {
            const value = Number.parseInt(readStored(HISTORY_H_KEY, ''), 10);
            return Number.isFinite(value) ? clampHistoryHeight(value) : null;
        };
        const listeners = new Set();
        const records = new Map();
        let snapshot = { chatOpen: false, revision: 0, sessions: [], listLoading: false, listError: '', connecting: false, hasMore: false, count: 40, activeId: null, creating: false };
        let ctxRef;
        let listRequest;
        let disposed = false;
        const emit = () => {
            if (disposed) return;
            snapshot = { ...snapshot, revision: snapshot.revision + 1 };
            for (const listener of listeners) listener();
        };
        const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
        const getSnapshot = () => snapshot;
        const useChat = () => React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
        const recordFor = (id) => {
            if (!records.has(id)) records.set(id, { messages: [], title: '', draft: '', files: [], loaded: false, loading: false, streaming: false, error: '', request: 0 });
            return records.get(id);
        };
        const requestJson = async (path, body, signal) => {
            const response = await bridgeFetch(path, {
                method: body === undefined ? 'GET' : 'POST', signal,
                headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            const data = await readBridgeJson(response);
            if (!response.ok) throw new Error(data.error || '无法连接聊天，请重试。');
            return data;
        };
        async function refreshList(count = snapshot.count) {
            if (listRequest) return listRequest;
            snapshot.count = count;
            snapshot.listLoading = true;
            snapshot.listError = '';
            emit();
            listRequest = (async () => {
                try {
                    const data = await requestJson('/sessions?count=' + count);
                    snapshot.sessions = data.sessions;
                    snapshot.hasMore = data.hasMore;
                } catch (error) { snapshot.listError = error.message; }
                finally { snapshot.listLoading = false; listRequest = null; emit(); }
            })();
            return listRequest;
        }
        async function refreshMessages(id, { force = false } = {}) {
            if (!id) return;
            const record = recordFor(id);
            if (record.streaming || (record.needsRefresh && !force)) return;
            const revision = ++record.request;
            record.loading = true;
            record.error = '';
            emit();
            try {
                const data = await requestJson('/messages?id=' + encodeURIComponent(id));
                if (revision !== record.request || record.streaming || disposed) return;
                record.messages = data.messages;
                record.title = data.title;
                record.loaded = true;
                record.needsRefresh = false;
            } catch (error) { if (revision === record.request) record.error = error.message; }
            finally { if (revision === record.request) record.loading = false; emit(); }
        }
        /**
         * Upload one picked file. The web side parses it asynchronously, so the
         * entry only becomes sendable once the bridge reports SUCCESS.
         */
        function addFiles(record, picked) {
            if (record.streaming || snapshot.creating) return;
            if (record.files.length + picked.length > MAX_ATTACHMENTS) {
                record.attachmentError = '每条消息最多附加 8 个文件。请减少所选文件后重试。';
                emit();
                return;
            }
            record.attachmentError = '';
            for (const file of picked) {
                if (file.size === 0 || file.size > MAX_UPLOAD) {
                    record.files.push({ localId: 'a' + Math.random().toString(36).slice(2), name: file.name,
                        size: file.size, status: 'error', error: file.size === 0 ? '文件为空。' : '文件超过 32 MB。', id: null });
                    continue;
                }
                const entry = { localId: 'a' + Math.random().toString(36).slice(2), name: file.name, size: file.size, status: 'uploading', id: null };
                const controller = new AbortController();
                entry.controller = controller;
                record.files = [...(record.files ?? []), entry];
                (async () => {
                    try {
                        const response = await bridgeFetch('/upload?name=' + encodeURIComponent(file.name), {
                            method: 'POST',
                            headers: { 'content-type': file.type || 'application/octet-stream' },
                            signal: controller.signal,
                            body: file,
                        });
                        const data = await readBridgeJson(response);
                        if (!response.ok) throw new Error(data.error || '上传失败。');
                        entry.id = data.id;
                        entry.name = data.name || entry.name;
                        entry.size = typeof data.size === 'number' ? data.size : entry.size;
                        entry.status = 'ready';
                    } catch (error) {
                        if (!controller.signal.aborted) {
                            entry.status = 'error';
                            entry.error = error?.message ?? '上传失败。';
                        }
                    } finally {
                        entry.controller = null;
                        emit();
                    }
                })();
            }
            emit();
        }
        function removeFile(record, localId) {
            if (record.streaming || snapshot.creating) return;
            record.files.find((file) => file.localId === localId)?.controller?.abort();
            record.files = (record.files ?? []).filter((file) => file.localId !== localId);
            if (record.files.every((file) => file.status !== 'error')) record.attachmentError = '';
            emit();
        }
        /**
         * Guided sign-in: the host opens a browser window against a throwaway
         * profile and resolves once the captured session passed the account check,
         * so this request stays pending for as long as the user needs to log in.
         */
        async function connectAccount() {
            if (snapshot.connecting) return;
            snapshot.connecting = true;
            snapshot.listError = '';
            emit();
            try {
                const response = await bridgeFetch('/login', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: '{}',
                });
                const data = await readBridgeJson(response);
                if (!response.ok) throw new Error(data.error || '连接失败。');
                await refreshList();
            } catch (error) {
                snapshot.listError = error?.message ?? '连接失败。';
            } finally {
                snapshot.connecting = false;
                emit();
            }
        }
        function rememberMode() {            const chat = snapshot.chatOpen && ctxRef.layout.panelInfo.getSnapshot().activePanelId === null;
            writeStored(LAST_PANEL, chat ? 'chat' : 'work');
            writeStored(MODE_KEY, chat ? 'chat' : 'work');
        }
        function openChat(id = null) {
            snapshot.activeId = id;
            snapshot.chatOpen = true;
            writeStored(LAST_ID, id || '');
            // Keep the native conversation mounted behind the chat layer.
            if (ctxRef.layout.panelInfo.getSnapshot().activePanelId !== null) ctxRef.layout.selectPanel(null);
            rememberMode();
            emit();
            if (id) refreshMessages(id);
        }
        let switchSequence = 0;
        function closeChat() {
            ++switchSequence;
            snapshot.chatOpen = false;
            snapshot.switching = null;
            rememberMode();
            emit();
        }
        function focusWorkInput() {
            requestAnimationFrame(() => {
                if (!snapshot.chatOpen && ctxRef.layout.panelInfo.getSnapshot().activePanelId === null) {
                    document.querySelector('.an3WzG_root:not([inert]) [contenteditable="true"]')?.focus();
                }
            });
        }
        async function start(mode) {
            if (mode === 'chat') {
                ++switchSequence;
                snapshot.switching = null;
                if (!snapshot.chatOpen || snapshot.activeId !== null) openChat();
                return;
            }
            // Returning to an already mounted empty Work composer is purely local:
            // no session/create request, panel replacement, screenshots or remounts.
            if (document.querySelector('[data-phase="hero"] .dsc-work-home-marker')) {
                closeChat();
                focusWorkInput();
                return;
            }
            const sequence = ++switchSequence;
            snapshot.switching = 'work';
            emit();
            ctxRef.uiWorkspace.startSession();
            const deadline = performance.now() + 1200;
            while (sequence === switchSequence && !disposed && performance.now() < deadline) {
                if (document.querySelector('[data-phase="hero"] .dsc-work-home-marker')) break;
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
            if (sequence === switchSequence && !disposed) { closeChat(); focusWorkInput(); }
        }
        function WebChatLayer({ translate }) {
            const state = useChat();
            const panel = React.useSyncExternalStore(
                (fn) => ctxRef.layout.panelInfo.subscribe(fn),
                () => ctxRef.layout.panelInfo.getSnapshot().activePanelId,
            );
            const [main, setMain] = React.useState(null);
            const visible = state.chatOpen && panel === null;
            React.useLayoutEffect(() => { setMain(document.querySelector('.mP3x-q_mainPanel')); }, []);
            React.useLayoutEffect(() => {
                if (!main) return;
                main.dataset.dscChatActive = visible ? 'true' : 'false';
                let restoreNative = () => {};
                let activeNative;
                const syncNative = () => {
                    const native = main.querySelector('.an3WzG_root');
                    if (native === activeNative) return;
                    restoreNative();
                    activeNative = native;
                    if (!native || !visible) { restoreNative = () => {}; return; }
                    const wasInert = native.hasAttribute('inert');
                    const wasHidden = native.getAttribute('aria-hidden');
                    native.setAttribute('inert', '');
                    native.setAttribute('aria-hidden', 'true');
                    restoreNative = () => {
                        if (!wasInert) native.removeAttribute('inert');
                        if (wasHidden === null) native.removeAttribute('aria-hidden'); else native.setAttribute('aria-hidden', wasHidden);
                    };
                };
                const observer = new MutationObserver(syncNative);
                observer.observe(main, { childList: true, subtree: true });
                syncNative();
                return () => { observer.disconnect(); restoreNative(); delete main.dataset.dscChatActive; };
            }, [main, visible, panel]);
            if (!main) return null;
            // The portal's target and child identity stay fixed across mode changes.
            return createPortal(h('div', {
                className: 'dsc-chat-layer', 'data-active': visible ? 'true' : 'false',
                inert: visible ? undefined : '', 'aria-hidden': !visible,
            }, h(ChatPage, { translate, visible })), main);
        }
        function stopReply(id) { recordFor(id).controller?.abort(); }
        async function sendMessage() {
            const oldId = snapshot.activeId;
            let record = recordFor(oldId);
            const prompt = record.draft.trim();
            const attachments = [...record.files];
            if ((!prompt && attachments.length === 0) || record.streaming || record.loading || snapshot.creating || record.needsRefresh) return;
            if (attachments.some((file) => file.status === 'uploading')) return;
            if (attachments.some((file) => file.status !== 'ready' || !file.id)) {
                record.attachmentError = '有附件未上传成功。请移除失败附件后重新添加。';
                emit();
                return;
            }
            const effort = effortFor(readDeep(), readSmart());
            const creating = !oldId;
            if (creating) snapshot.creating = true;
            record.error = '';
            record.attachmentError = '';
            emit();
            let id = oldId;
            let originalMessages;
            let assistant;
            let streamOpened = false;
            let completed = false;
            try {
                if (!id) {
                    const created = await requestJson('/sessions/create', {});
                    id = created.id;
                    const draft = record.draft;
                    record.draft = '';
                    record.files = [];
                    record = recordFor(id);
                    record.draft = draft;
                    record.files = attachments;
                    record.loaded = true;
                    record.title = (prompt || attachments[0]?.name || '新聊天').slice(0, 36);
                    snapshot.sessions = [{ id, title: record.title, updatedAt: Date.now() }, ...snapshot.sessions];
                    // A delayed create must not navigate away from another chat.
                    if (snapshot.activeId === oldId) {
                        snapshot.activeId = id;
                        writeStored(LAST_ID, id);
                    }
                }
                record.request++;
                record.streaming = true;
                record.loading = false;
                record.controller = new AbortController();
                originalMessages = record.messages;
                assistant = { role: 'assistant', text: '', thinking: '', localId: 'reply-' + Date.now(), status: 'STREAMING' };
                record.messages = [...originalMessages, { role: 'user', text: prompt, localId: 'user-' + Date.now() }, assistant];
                if (creating) snapshot.creating = false;
                emit();
                const response = await bridgeFetch('/messages/send', {
                    method: 'POST', headers: { 'content-type': 'application/json' }, signal: record.controller.signal,
                    body: JSON.stringify({ id, prompt, effort, files: attachments.map((file) => file.id) }),
                });
                if (!response.ok) { const data = await readBridgeJson(response); throw new Error(data.error || '发送失败，请重试。'); }
                streamOpened = true;
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '', finished = false;
                try {
                    while (!finished) {
                        const chunk = await reader.read();
                        if (chunk.done) break;
                        buffer += decoder.decode(chunk.value, { stream: true });
                        let end;
                        while ((end = buffer.indexOf('\n')) >= 0) {
                            const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
                            if (!line.startsWith('data:')) continue;
                            const event = JSON.parse(line.slice(5));
                            if (event.type === 'text-delta') assistant.text += event.text;
                            else if (event.type === 'reasoning-delta') assistant.thinking += event.text;
                            else if (event.type === 'finish') {
                                if (event.reason?.kind === 'error') throw new Error(event.reason.failure?.message || '回复失败。');
                                if (event.reason?.kind !== 'stop') throw new Error('回复结束状态不明，请刷新核对。');
                                finished = true;
                                break;
                            }
                        }
                        emit();
                    }
                } finally {
                    reader.cancel().catch(() => {});
                    reader.releaseLock();
                }
                if (!finished) throw new Error('连接中断，请刷新核对网页版记录后继续。');
                completed = true;
                assistant.status = 'FINISHED';
                record.draft = '';
                record.files = [];
            } catch (error) {
                const stopped = record.controller?.signal.aborted === true;
                const hasPartial = Boolean(assistant && (assistant.text || assistant.thinking));
                if (hasPartial) assistant.status = 'INTERRUPTED';
                else if (originalMessages) record.messages = originalMessages;
                record.needsRefresh = streamOpened || stopped || hasPartial;
                record.error = stopped ? '已停止回复。请刷新核对网页版记录后继续。'
                    : error?.message ?? '发送失败，请重试。';
            } finally {
                if (creating && !id) snapshot.creating = false;
                record.streaming = false;
                record.controller = null;
                emit();
                if (completed) await refreshMessages(id);
                await refreshList();
            }
        }
        function whenText(value) {
            if (!value) return '';
            const date = new Date(value), now = new Date();
            if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return date.getFullYear() === now.getFullYear() ? `${date.getMonth() + 1}/${date.getDate()}` : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
        }
        const icon = (name, fallback, size = 16) => {
            const component = primitives[name];
            return component ? h(component, { size }) : h('span', { 'aria-hidden': true }, fallback);
        };
        /** Paperclip glyph, matching the web composer's attachment control. */
        const PAPERCLIP = h('svg', {
            width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
            strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        }, h('path', { d: 'M20.5 11.5 12.2 19.8a5.1 5.1 0 0 1-7.2-7.2l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8' }));
        function HistoryList({ wide, expandSidebar }) {
            const state = useChat();
            const [filter, setFilter] = React.useState('');
            const [searchOpen, setSearchOpen] = React.useState(false);
            const searchRoot = React.useRef(null);
            const searchInput = React.useRef(null);
            const [height, setHeight] = React.useState(readHistoryHeight);
            const heightRef = React.useRef(height);
            const drag = React.useRef(null);
            // Same shape as the workspace search: the field is always mounted and only
            // widens while expanded, so focus and Escape behave like the shipped one.
            React.useEffect(() => {
                if (!searchOpen) return undefined;
                searchInput.current?.focus({ preventScroll: true });
                return undefined;
            }, [searchOpen]);
            React.useEffect(() => {
                if (!searchOpen) return undefined;
                const onPointerDown = (event) => {
                    if (!(event.target instanceof Node)) return;
                    if (searchRoot.current?.contains(event.target) === true) return;
                    searchInput.current?.blur();
                    if (filter.trim() !== '') return;
                    setSearchOpen(false);
                };
                document.addEventListener('mousedown', onPointerDown);
                return () => document.removeEventListener('mousedown', onPointerDown);
            }, [searchOpen, filter]);
            const conversationSelected = React.useSyncExternalStore(
                (fn) => ctxRef.layout.panelInfo.subscribe(fn),
                () => ctxRef.layout.panelInfo.getSnapshot().activePanelId === null,
            );
            const active = conversationSelected && state.chatOpen;
            if (!wide) return h('button', { className: 'dsc-rail', title: '聊天', 'aria-label': '打开聊天列表', onClick: () => { expandSidebar?.(); openChat(snapshot.activeId); } }, icon('IconChatOutlineRegular', '◌', 18));
            const rows = state.sessions.filter((session) => session.title.toLowerCase().includes(filter.toLowerCase()));
            // The drag handle owns the block's height so the workspace list above it
            // can take the rest of the column; the CSS clamp stays the default.
            const applyHeight = (value) => {
                heightRef.current = value;
                setHeight(value);
            };
            const onDragStart = (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                const box = event.currentTarget.parentElement?.getBoundingClientRect();
                drag.current = { y: event.clientY, height: box?.height ?? 260 };
                event.currentTarget.setPointerCapture?.(event.pointerId);
                document.body.style.userSelect = 'none';
                document.body.style.cursor = 'row-resize';
            };
            const onDragMove = (event) => {
                const start = drag.current;
                if (!start) return;
                applyHeight(clampHistoryHeight(start.height - (event.clientY - start.y)));
            };
            const onDragEnd = (event) => {
                if (!drag.current) return;
                drag.current = null;
                event.currentTarget.releasePointerCapture?.(event.pointerId);
                document.body.style.userSelect = '';
                document.body.style.cursor = '';
                if (heightRef.current) writeStored(HISTORY_H_KEY, String(heightRef.current));
            };
            const onDragKey = (event) => {
                const step = event.key === 'ArrowUp' ? 24 : event.key === 'ArrowDown' ? -24 : 0;
                if (step === 0) return;
                event.preventDefault();
                const box = event.currentTarget.parentElement?.getBoundingClientRect();
                const next = clampHistoryHeight((heightRef.current ?? box?.height ?? 260) + step);
                applyHeight(next);
                writeStored(HISTORY_H_KEY, String(next));
            };
            const onDragReset = () => {
                applyHeight(null);
                try {
                    window.localStorage.removeItem(HISTORY_H_KEY);
                } catch {
                    // A blocked storage only means the default comes back every time.
                }
            };
            return h('section', {
                className: 'dsc-history',
                'aria-label': '聊天历史',
                style: height ? { height: height + 'px' } : undefined,
            }, [
                h('div', {
                    key: 'resize',
                    className: 'dsc-resize',
                    role: 'separator',
                    'aria-orientation': 'horizontal',
                    'aria-label': '拖动调整聊天区域高度，双击恢复默认',
                    'aria-valuemin': HISTORY_MIN,
                    'aria-valuemax': historyMax(),
                    'aria-valuenow': height ?? undefined,
                    tabIndex: 0,
                    onPointerDown: onDragStart,
                    onPointerMove: onDragMove,
                    onPointerUp: onDragEnd,
                    onPointerCancel: onDragEnd,
                    onKeyDown: onDragKey,
                    onDoubleClick: onDragReset,
                }),
                h('div', { key: 'head', className: 'dsc-section-head' }, [
                    searchOpen ? null : h('span', { key: 'title', className: 'dsc-section-title' }, '聊天'),
                    // The spacer sits before the search seat, so the icon lines up with the
                    // refresh/new buttons; expanding drops the spacer and lets the field fill.
                    searchOpen ? null : h('span', { key: 'spacer', style: { flex: 1 } }),
                    h('div', {
                        key: 'searchSlot',
                        className: 'dsc-search-slot' + (searchOpen ? ' is-open' : ''),
                    }, h('div', {
                        ref: searchRoot,
                        className: 'dsc-search' + (searchOpen ? ' is-open' : ''),
                        onClick: () => {
                            setSearchOpen(true);
                            searchInput.current?.focus({ preventScroll: true });
                        },
                    }, [
                        h('button', {
                            key: 'btn', type: 'button', className: 'dsc-icon dsc-search-btn',
                            'aria-label': '搜索聊天', 'aria-expanded': searchOpen ? 'true' : 'false',
                            title: searchOpen ? undefined : '搜索聊天',
                            onClick: (event) => {
                                event.stopPropagation();
                                if (searchOpen) {
                                    setFilter('');
                                    setSearchOpen(false);
                                } else {
                                    setSearchOpen(true);
                                }
                            },
                        }, icon('IconSearchOutlineRegular', '🔍', searchOpen ? 11 : 14)),
                        h('input', {
                            key: 'input', ref: searchInput, className: 'dsc-search-input', type: 'text',
                            placeholder: '搜索聊天', value: filter, tabIndex: searchOpen ? 0 : -1,
                            'aria-label': '搜索聊天',
                            onChange: (event) => setFilter(event.target.value),
                            onKeyDown: (event) => {
                                if (event.key !== 'Escape') return;
                                event.preventDefault();
                                setFilter('');
                                setSearchOpen(false);
                            },
                        }),
                        searchOpen ? h('button', {
                            key: 'clear', type: 'button', className: 'dsc-icon dsc-search-clear', 'aria-label': '清除搜索',
                            onClick: (event) => {
                                event.stopPropagation();
                                setFilter('');
                                setSearchOpen(false);
                            },
                        }, '×') : null,
                    ])),
                    h('button', { key: 'connect', className: 'dsc-icon', title: '连接网页版账号', 'aria-label': '连接网页版账号', disabled: state.connecting, onClick: () => { connectAccount(); } }, icon('IconLinkOutlineRegular', '🔌')),
                    h('button', { key: 'refresh', className: 'dsc-icon', title: '同步网页版聊天', 'aria-label': '同步网页版聊天', disabled: state.listLoading, onClick: () => { refreshList(); if (snapshot.activeId) refreshMessages(snapshot.activeId, { force: true }); } }, icon('IconRefreshOutlineRegular', '↻')),
                    h('button', { key: 'new', className: 'dsc-icon', title: '新聊天', 'aria-label': '新聊天', onClick: () => openChat() }, icon('IconNewChatOutlineRegular', '+')),
                ]),
                state.listError || state.connecting ? h('div', { key: 'error', className: 'dsc-list-error', role: 'status' }, [
                    state.connecting ? '已打开登录窗口，登录后会自动刷新…' : state.listError,
                    state.connecting ? null : h('button', { key: 'retry', className: 'dsc-link', onClick: () => { refreshList(); } }, '重试'),
                    state.connecting ? null : h('button', { key: 'connect', className: 'dsc-link', onClick: () => { connectAccount(); } }, '连接账号'),
                ]) : null,
                h('div', { key: 'list', className: 'dsc-history-scroll' }, [
                    ...rows.map((session) => h('button', { key: session.id, className: 'dsc-history-row', 'aria-current': active && session.id === state.activeId ? 'page' : undefined, title: session.title, onClick: () => openChat(session.id) }, [
                        h('span', { key: 'title', className: 'dsc-history-title' }, session.title),
                        h('time', { key: 'time', dateTime: session.updatedAt ? new Date(session.updatedAt).toISOString() : undefined }, whenText(session.updatedAt)),
                    ])),
                    !rows.length ? h('div', { key: 'empty', className: 'dsc-empty-list' }, state.listLoading ? '正在同步…' : filter ? '没有匹配的聊天' : state.listError ? '' : '还没有网页版聊天') : null,
                    state.hasMore && !filter ? h('button', { key: 'more', className: 'dsc-more', disabled: state.listLoading || state.count >= 100, onClick: () => refreshList(Math.min(100, state.count + 20)) }, state.count >= 100 ? '已同步最近 100 条' : '显示更多') : null,
                ]),
            ]);
        }
        const labels = { code: { copyLabel: '复制', copiedLabel: '已复制', toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' } }, footnotes: '注释' };
        function Markdown({ text, streaming }) {
            return h(primitives.MarkdownText, { text: text || '', streaming, labels });
        }
        function SendGlyph({ stop = false }) {
            return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
                stop ? h('rect', { x: 3, y: 3, width: 10, height: 10, rx: 3, fill: 'currentColor' })
                : h('path', { d: 'M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z', fill: 'currentColor' }));
        }
        function ChatPage({ translate, visible }) {
            const state = useChat(), record = recordFor(state.activeId);
            const scroll = React.useRef(null), tail = React.useRef(null), stick = React.useRef(true), input = React.useRef(null), picker = React.useRef(null);
            const files = record.files ?? [];
            const unresolvedFile = files.some((file) => file.status !== 'ready');
            React.useLayoutEffect(() => { stick.current = true; }, [state.activeId]);
            React.useLayoutEffect(() => {
                if (visible && stick.current) tail.current?.scrollIntoView({ block: 'end' });
            }, [state.revision, visible]);
            React.useEffect(() => { if (visible) input.current?.focus(); }, [state.activeId, visible]);
            const title = record.title || state.sessions.find((row) => row.id === state.activeId)?.title || '新聊天';
            return h('section', { className: 'dsc-page', 'data-home': state.activeId === null ? 'true' : 'false', 'aria-label': '网页版聊天' }, [
                h('header', { key: 'header', className: 'dsc-page-head' }, [
                    h('div', { key: 'title', className: 'dsc-page-title', title }, title),
                    h('span', { key: 'source', className: 'dsc-source' }, 'DeepSeek 网页版'),
                    state.activeId ? h('a', { key: 'web', className: 'dsc-icon dsc-web-link', href: 'https://chat.deepseek.com/a/chat/s/' + encodeURIComponent(state.activeId), target: '_blank', rel: 'noopener noreferrer', title: '在网页版打开', 'aria-label': '在网页版打开' }, '↗') : null,
                ]),
                h('div', { key: 'messages', ref: scroll, className: 'dsc-messages', onScroll: () => { const el = scroll.current; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; } }, [
                    record.loading && !record.loaded ? h('div', { key: 'loading', className: 'dsc-status' }, '正在读取对话…') : null,
                    !state.activeId && !record.messages.length ? h('div', { key: 'welcome', className: 'dsc-welcome' }, h('h1', { key: 'title' }, '有什么想聊的？')) : null,
                    h('div', { key: 'thread', className: 'dsc-thread' }, record.messages.map((message, index) => h('article', { key: message.messageId ?? message.localId ?? index, className: 'dsc-message ' + (message.role === 'user' ? 'dsc-user' : 'dsc-assistant'), 'aria-label': message.role === 'user' ? '你' : 'DeepSeek' }, [
                        message.thinking ? h('details', { key: 'thinking', className: 'dsc-thinking' }, [h('summary', { key: 'label' }, record.streaming && index === record.messages.length - 1 && !message.text ? '正在深度思考…' : '深度思考'), h(Markdown, { key: 'body', text: message.thinking, streaming: record.streaming && index === record.messages.length - 1 })]) : null,
                        h('div', { key: 'text', className: 'dsc-message-text' }, message.role === 'user' ? message.text : h(Markdown, { text: message.text || (record.streaming && index === record.messages.length - 1 ? '正在回复…' : ''), streaming: record.streaming && index === record.messages.length - 1 })),
                    ]))),
                    h('div', { key: 'tail', ref: tail }),
                ]),
                h('div', { key: 'composerWrap', className: 'dsc-composer-wrap' }, [
                    record.error ? h('div', { key: 'error', className: 'dsc-error', role: 'alert' }, [record.error, state.activeId ? h('button', { key: 'retry', className: 'dsc-link', onClick: () => refreshMessages(state.activeId, { force: true }) }, '刷新对话') : null]) : null,
                    (record.attachmentError || files.some((file) => file.status === 'error'))
                        ? h('div', { key: 'attachment-error', className: 'dsc-error', role: 'alert' },
                            record.attachmentError || '有附件上传失败。请移除失败附件后重新添加。')
                        : null,
                    h('form', { key: 'composer', className: 'dsc-composer', onSubmit: (event) => { event.preventDefault(); sendMessage(); } }, [
                        h('input', {
                            key: 'picker', ref: picker, type: 'file', multiple: true, tabIndex: -1,
                            className: 'dsc-file-input', 'aria-hidden': 'true',
                            onChange: (event) => {
                                const picked = Array.from(event.target.files ?? []);
                                event.target.value = '';
                                if (picked.length) addFiles(record, picked);
                            },
                        }),
                        files.length ? h('div', { key: 'files', className: 'dsc-files' }, files.map((file) => h('span', {
                            key: file.localId, className: 'dsc-file', 'data-status': file.status, title: file.error || file.name,
                        }, [
                            h('span', { key: 'name', className: 'dsc-file-name' }, file.name),
                            file.status === 'uploading' ? h('span', { key: 'state', className: 'dsc-file-state' }, '解析中…') : null,
                            file.status === 'error' ? h('span', { key: 'state', className: 'dsc-file-state' }, '失败') : null,
                            h('button', {
                                key: 'x', type: 'button', className: 'dsc-file-x', title: '移除',
                                disabled: record.streaming || state.creating,
                                'aria-label': '移除 ' + file.name, onClick: () => removeFile(record, file.localId),
                            }, '×'),
                        ]))) : null,
                        h('textarea', { key: 'input', ref: input, className: 'dsc-input', 'aria-label': '发送聊天消息', placeholder: '发消息', rows: 2, value: record.draft, readOnly: record.streaming, disabled: state.creating || record.loading, onChange: (event) => { record.draft = event.target.value; emit(); }, onKeyDown: (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendMessage(); } } }),
                        h('div', { key: 'actions', className: 'dsc-composer-actions' }, [
                            h(ChatControls, { key: 'controls', translate }),
                            h('span', { key: 'spacer', style: { flex: 1 } }),
                            h('button', {
                                key: 'attach', type: 'button', className: 'dsc-attach', title: '上传文件',
                                'aria-label': '上传文件', disabled: record.streaming || state.creating,
                                onClick: () => picker.current?.click(),
                            }, PAPERCLIP),
                            record.streaming ? h('button', { key: 'stop', className: 'dsc-send', type: 'button', title: '停止回复', 'aria-label': '停止回复', onClick: () => stopReply(state.activeId) }, h(SendGlyph, { stop: true })) : h('button', { key: 'send', className: 'dsc-send', type: 'submit', title: '发送消息', 'aria-label': '发送聊天消息', disabled: (!record.draft.trim() && !files.length) || unresolvedFile || record.loading || state.creating || record.needsRefresh }, h(SendGlyph)),
                        ]),
                    ]),
                ]),
            ]);
        }
        const CSS = `
.wtg9ga_footerActions:has(.dsc-history){flex-wrap:wrap}
.dsc-history{box-sizing:border-box;display:flex;flex-direction:column;flex:1 0 100%;width:100%;height:clamp(180px,38vh,380px);min-height:0;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,#e7e7e7)}
.dsc-resize{flex:none;height:10px;margin:-6px 0 2px;border-radius:4px;cursor:row-resize;touch-action:none;position:relative;transition:background 120ms ease}
.dsc-resize:hover{background:var(--dsw-alias-bg-layer-2,#eee)}
.dsc-resize:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#777);outline-offset:-2px}
.dsc-section-head{display:flex;align-items:center;gap:4px;min-height:30px;padding:0 4px 0 8px;flex:none}
.dsc-section-title{font-size:13px;color:var(--dsw-alias-label-secondary,#777);font-weight:500}
.dsc-icon,.dsc-rail{border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;font:inherit;flex:none;text-decoration:none}
.dsc-icon:hover,.dsc-rail:hover{background:var(--dsw-alias-bg-layer-2,#eee)}
.dsc-rail{width:36px;height:36px;margin-top:10px}
.dsc-icon:disabled{opacity:.4;cursor:default}
.dsc-search-slot{display:flex;align-items:center;min-width:0;flex:0 0 auto}
.dsc-search-slot.is-open{flex:1 1 auto;margin-right:4px}
.dsc-search{display:flex;align-items:center;gap:1px;min-width:0;border-radius:7px;border:1px solid transparent}
.dsc-search.is-open{flex:1 1 auto;background:var(--dsw-alias-bg-base,#fff);border-color:var(--dsw-alias-border-l2,#ddd);padding:0 1px 0 2px}
.dsc-search-input{width:0;min-width:0;padding:0;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;opacity:0;transition:width 160ms ease,opacity 120ms ease}
.dsc-search.is-open .dsc-search-input{flex:1 1 auto;width:auto;padding:4px 2px;opacity:1}
.dsc-search-input::placeholder{color:var(--dsw-alias-label-secondary,#999)}
.dsc-search-clear{width:20px;height:20px;font-size:14px;line-height:1;opacity:.6}
.dsc-search-clear:hover{opacity:1}
.dsc-history-scroll{min-height:0;overflow-y:auto;padding:0 3px 12px;flex:1}
.dsc-history-row{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;font:inherit;font-size:13px;line-height:20px;padding:7px 9px;border-radius:8px;cursor:pointer;margin:1px 0}
.dsc-history-row:hover,.dsc-history-row[aria-current=page]{background:var(--dsw-alias-bg-layer-2,#eaeaea)}
.dsc-history-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-history-row time{font-size:11px;color:var(--dsw-alias-label-secondary,#999);flex:none}
.dsc-empty-list,.dsc-list-error{font-size:12px;line-height:1.6;padding:10px;color:var(--dsw-alias-label-secondary,#777)}
.dsc-list-error{max-height:100px;overflow:auto}
.dsc-list-error .dsc-link{margin-left:8px;white-space:nowrap}
.dsc-link,.dsc-more{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:4px 8px;text-decoration:underline;text-underline-offset:3px}
.dsc-more{width:100%;text-align:left;text-decoration:none;padding:9px}
.dsc-more:disabled{cursor:default;color:var(--dsw-alias-label-secondary,#999)}
.dsc-page{position:relative;display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;height:100%;color:var(--dsw-alias-label-primary)}
.dsc-page-head{display:flex;align-items:center;gap:12px;flex:none;min-height:60px;padding:0 28px;border-bottom:1px solid var(--dsw-alias-border-l1,#eee)}
.dsc-page-title{font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.dsc-source{font-size:12px;color:var(--dsw-alias-label-secondary,#888);white-space:nowrap}
.dsc-messages{overflow:auto;min-height:0;flex:1;padding:24px 28px 12px;scrollbar-gutter:stable}
.dsc-thread{max-width:760px;margin:auto}
.dsc-message{margin:0 0 30px;line-height:1.8;font-size:var(--dsh-content-font-size,15px);min-width:0;overflow-wrap:anywhere}
.dsc-user{display:flex;flex-direction:column;align-items:flex-end}
.dsc-user .dsc-message-text{max-width:85%;border-radius:18px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);padding:10px 18px;white-space:pre-wrap}
.dsc-assistant .dsc-message-text{min-width:0}
.dsc-thinking{color:var(--dsw-alias-label-secondary,#888);font-size:13px;line-height:1.7;margin-bottom:12px}
.dsc-thinking summary{cursor:pointer;user-select:none;width:fit-content}
.dsc-thinking[open]>:not(summary){margin-top:8px;border-left:2px solid var(--dsw-alias-border-l2,#ddd);padding-left:14px}
.dsc-welcome{height:100%;min-height:160px;display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center;gap:12px}
.dsc-welcome h1{font-size:26px;font-weight:500;margin:0}
.dsc-welcome p{font-size:13px;color:var(--dsw-alias-label-secondary,#888);margin:0;line-height:1.8}
.dsc-status{padding:24px;text-align:center;color:var(--dsw-alias-label-secondary,#888)}
.dsc-composer-wrap{flex:none;width:calc(100% - 56px);max-width:780px;align-self:center;padding-bottom:12px}
.dsc-composer{background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:22px;padding:12px 14px 10px;box-shadow:0 2px 10px #00000006}
.dsc-input{display:block;box-sizing:border-box;width:100%;resize:none;min-height:58px;max-height:180px;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:1.7;padding:4px;overflow-y:auto}
.dsc-input::placeholder{color:var(--dsw-alias-label-secondary,#999)}
.dsc-composer-actions{display:flex;align-items:center;gap:6px;padding-top:8px}
.dsc-send{corner-shape:round;display:grid;place-items:center;width:34px;height:34px;padding:0;flex:none;border:0;border-radius:999px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);cursor:pointer;transform:translateY(-2px);transition:background-color .1s}
@media(hover:hover){.dsc-send:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#cc3b83)}}
.dsc-send:disabled{opacity:.4;cursor:default}
.dsc-attach{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#666);width:32px;height:32px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.dsc-attach:hover{background:var(--dsw-alias-bg-layer-2,#eee)}
.dsc-attach:disabled{opacity:.35;cursor:default}
.dsc-file-input{display:none}
.dsc-files{display:flex;flex-wrap:wrap;gap:6px;padding:0 4px 8px}
.dsc-file{display:inline-flex;align-items:center;gap:6px;max-width:240px;padding:4px 8px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f1f1f1);font-size:12px;line-height:1.4;color:var(--dsw-alias-label-primary)}
.dsc-file[data-status=error]{color:var(--dsw-alias-state-error-primary,#b33)}
.dsc-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-file-state{color:var(--dsw-alias-label-secondary,#999);flex:none}
.dsc-file-x{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:14px;line-height:1;padding:0 2px;opacity:.55}
.dsc-file-x:hover{opacity:1}
.dsc-composer-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#999);text-align:center;padding-top:9px}
.dsc-error{font-size:12px;line-height:1.7;padding:8px 12px;margin-bottom:8px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary,#b33);overflow-wrap:anywhere}
/* Shared new-session geometry. Only empty states use these positions. */
.dsc-mode-overlay{position:fixed;z-index:30;transform:translateX(-50%);width:168px;height:38px;pointer-events:auto;-webkit-app-region:no-drag}
.dsc-mode-switch{box-sizing:border-box;display:grid;grid-template-columns:1fr 1fr;gap:4px;position:relative;isolation:isolate;width:100%;height:38px;padding:3px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f1f2f4)}
.dsc-mode-thumb{position:absolute;z-index:-1;left:3px;top:3px;bottom:3px;width:calc((100% - 10px)/2);border-radius:999px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 1px 4px #0000000d,inset 0 0 0 1px var(--dsw-alias-border-l1,#e8e8e8);transform:translateX(0);transition:transform 300ms cubic-bezier(.22,1,.36,1);will-change:transform}
.dsc-mode-switch[data-mode=work] .dsc-mode-thumb{transform:translateX(calc(100% + 4px))}
.dsc-mode-switch button{appearance:none;display:flex;align-items:center;justify-content:center;min-width:0;padding:0 14px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#777);cursor:pointer;font:inherit;font-size:13px;line-height:1;transition:color 180ms ease,background 180ms ease}
.dsc-mode-switch button[aria-selected=true]{color:var(--dsw-alias-label-primary,#171717);font-weight:500}
.dsc-mode-switch button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#777);outline-offset:2px}
.dsc-page[data-home=true] .dsc-page-head{visibility:hidden;height:40px;min-height:40px;border:0}
.dsc-page[data-home=true] .dsc-messages{padding:0;overflow:hidden;scrollbar-gutter:auto}
.dsc-page[data-home=true] .dsc-welcome{position:absolute;top:calc(50% - 114px);left:24px;right:24px;height:72px;min-height:0;justify-content:flex-start;gap:16px}
.dsc-page[data-home=true] .dsc-welcome h1{font-size:26px;line-height:32px}
.dsc-page[data-home=true] .dsc-welcome p{line-height:20px}
.dsc-page[data-home=true] .dsc-composer-wrap{position:absolute;left:50%;top:calc(50% + 18px);transform:translateX(-50%);width:min(780px,calc(100% - 56px));max-width:none;padding:0}
.dsc-page[data-home=true] .dsc-composer{box-sizing:border-box;min-height:128px;display:flex;flex-direction:column}
.dsc-page[data-home=true] .dsc-input{flex:1;min-height:52px}
.dsc-page[data-home=true] .dsc-composer-actions{flex:none}
/* Preserve the native editor, workspace picker, preset and model controls. */
.an3WzG_root[data-phase=hero]:has(.dsc-work-home-marker) .an3WzG_scrollBody{position:relative;justify-content:flex-start;overflow:visible;scrollbar-gutter:auto;margin-right:0}
.an3WzG_root[data-phase=hero]:has(.dsc-work-home-marker) .an3WzG_composerHero{--dsh-composer-card-max-width:780px;--dsh-composer-side-clearance:0px;--dsh-composer-dock-inset:0px;position:absolute;left:50%;top:calc(50% - 2px);transform:translateX(-50%);width:min(780px,calc(100% - 56px));margin:0;padding:0;gap:0}
.an3WzG_root[data-phase=hero]:has(.dsc-work-home-marker) .WOwLGG_root{position:absolute;top:-132px;left:0;right:0;height:40px;padding:0}
.an3WzG_root[data-phase=hero]:has(.dsc-work-home-marker) .an3WzG_heroWorkspaceRow{position:absolute;top:-76px;left:0;right:0;height:28px;min-height:28px;margin:0;padding:0 12px}
.an3WzG_root[data-phase=hero]:has(.dsc-work-home-marker) .GRgSLq_card{min-height:128px}
/* Both modes stay mounted; only composited opacity changes. */
.mP3x-q_mainPanel{position:relative;isolation:isolate}
.mP3x-q_mainPanel .an3WzG_root{opacity:1;transition:opacity 160ms ease;will-change:opacity}
.mP3x-q_mainPanel[data-dsc-chat-active=true] .an3WzG_root{opacity:0;pointer-events:none}
.dsc-chat-layer{position:absolute;inset:0;z-index:2;background:var(--dsw-alias-bg-base,#fff);opacity:0;pointer-events:none;transition:opacity 160ms ease;will-change:opacity;overflow:hidden}
.dsc-chat-layer[data-active=true]{opacity:1;pointer-events:auto}
@media(prefers-reduced-motion:reduce){.dsc-mode-thumb,.dsc-mode-switch button,.dsc-chat-layer,.mP3x-q_mainPanel .an3WzG_root{transition:none}}
@media(max-height:520px){.dsc-page[data-home=true] .dsc-welcome{top:calc(50% - 96px)}.dsc-page[data-home=true] .dsc-composer-wrap{top:calc(50% + 18px)}.dsc-page[data-home=true] .dsc-composer-hint{display:none}.an3WzG_root[data-phase=hero]:has(.dsc-work-home-marker) .WOwLGG_root{top:-114px}}
@media(max-width:680px){.dsc-page-head{padding:0 16px}.dsc-messages{padding:18px 16px}.dsc-composer-wrap{width:calc(100% - 24px)}.dsc-source{display:none}.dsc-welcome h1{font-size:22px}}
`;
        return {
            inject: ['slots', 'uiWorkspace', 'locale', 'layout'],
            apply(ctx) {
              try {
                ctxRef = ctx;
                for (const [locale, dict] of DICTS) ctx.effect(() => ctx.locale.register(NS, locale, dict), "chat: locale " + locale);
                const translate = ctx.locale.bind(NS);
                ctx.effect(() => { const style = document.createElement('style'); style.dataset.plugin = NS; style.textContent = CSS; document.head.appendChild(style); return () => style.remove(); });
                ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'web-chat-layer' }, () => h(WebChatLayer, { translate })));
                ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'chat-work-tabs', order: 10 }, (props) => props.session?.blank ? h('span', { className: 'dsc-work-home-marker', hidden: true }) : null));
                ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'chat-work-mode-switch' }, () => h(ModeSwitcher, { translate })));
                // A persistent peer section above the account/settings footer.
                // The native sidebar and workspace registry keep sole ownership of
                // their child slots, search, groups and session menus.
                ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
                    name: 'sidebar.footer.action', id: 'web-chat-history', order: 20,
                }, (props) => h(HistoryList, { wide: props.wide, expandSidebar: () => ctx.layout.toggleSidebar() })));
                ctx.effect(() => {
                    const restore = readStored(LAST_PANEL, 'work') === 'chat';
                    refreshList();
                    if (restore) openChat(readStored(LAST_ID, '') || null);
                    const offPanel = ctx.layout.panelInfo.subscribe(() => {
                        if (ctx.layout.panelInfo.getSnapshot().activePanelId !== null) {
                            snapshot.chatOpen = false;
                            snapshot.switching = null;
                            ++switchSequence;
                            emit();
                        }
                        rememberMode();
                    });
                    const onNativeNavigation = (event) => {
                        const target = event.target instanceof Element ? event.target : null;
                        const row = target?.closest('[data-row-key^="session:"]');
                        const newSession = target?.closest('.wtg9ga_newSession, .hc2fJa_iconButton[aria-label="新建会话"]');
                        if (event.type === 'click' ? row || newSession : ((row && ['Enter', ' '].includes(event.key)) || (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'n'))) closeChat();
                    };
                    document.addEventListener('click', onNativeNavigation, true);
                    document.addEventListener('keydown', onNativeNavigation, true);
                    const onFocus = () => { refreshList(); if (snapshot.chatOpen && ctx.layout.panelInfo.getSnapshot().activePanelId === null && snapshot.activeId) refreshMessages(snapshot.activeId); };
                    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') refreshList(); }, 60000);
                    window.addEventListener('focus', onFocus);
                    return () => { disposed = true; bridgeLifetime.abort(); ++switchSequence; document.removeEventListener('click', onNativeNavigation, true); document.removeEventListener('keydown', onNativeNavigation, true); offPanel(); window.clearInterval(timer); window.removeEventListener('focus', onFocus); for (const record of records.values()) record.controller?.abort(); listeners.clear(); };
                });
              } catch (error) { console.error("chat-work-tabs activation:", error); throw error; }
            },
        };
    },
});
