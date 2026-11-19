import { CHAT_MAX_LENGTH, cleanChatText } from './chat-rules.js';

export class RoomChat {
  constructor({ send, requestId }) {
    this.send = send;
    this.requestId = requestId;
    this.button = document.querySelector('#chatButton');
    this.panel = document.querySelector('#chatPanel');
    this.list = document.querySelector('#chatMessages');
    this.input = document.querySelector('#chatInput');
    this.submit = document.querySelector('#chatSend');
    this.error = document.querySelector('#chatError');
    this.badge = document.querySelector('#chatUnread');
    this.newMessages = document.querySelector('#chatNewMessages');
    this.tabButton = document.querySelector('#chatTab');
    this.tabBadge = document.querySelector('#chatTabUnread');
    this.sidebar = document.querySelector('.insight-panel');
    this.floatingAnchor = this.button.parentElement;
    this.sidebarTab = 'live';
    this.desktop = matchMedia('(min-width: 1051px)');
    this.desktop.addEventListener('change', () => this.syncLayout());
    this.input.maxLength = CHAT_MAX_LENGTH;
    this.version = -1;
    this.unread = 0;
    this.connected = true;
    this.button.addEventListener('click', () => this.toggle(this.panel.hidden));
    document.querySelector('#chatClose').addEventListener('click', () => this.toggle(false, true));
    document.querySelector('#chatForm').addEventListener('submit', event => {
      event.preventDefault();
      if (!this.composing) this.publish();
    });
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; this.updateComposer(); });
    // Enter used to confirm Chinese input must not submit the form.
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229 || this.composing)) event.preventDefault();
    });
    this.input.addEventListener('input', () => {
      this.error.textContent = '';
      this.updateComposer();
    });
    this.newMessages.addEventListener('click', () => this.scrollToLatest());
    this.list.addEventListener('scroll', () => {
      if (!this.panel.hidden && this.atBottom()) this.markRead();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !this.docked && !this.panel.hidden) {
        event.preventDefault();
        this.toggle(false, true);
      }
    });
    document.addEventListener('click', event => {
      if (!this.docked && !this.panel.hidden && !this.panel.contains(event.target) && !this.button.contains(event.target)) this.toggle(false);
    });
    // Keep the composer above the on-screen keyboard without resizing the table.
    if (window.visualViewport) {
      const position = () => {
        if (this.panel.hidden) return;
        const viewport = window.visualViewport;
        this.panel.style.setProperty('--chat-viewport-top', `${viewport.offsetTop + 8}px`);
        this.panel.style.setProperty('--chat-viewport-height', `${viewport.height - 16}px`);
      };
      this.position = position;
      window.visualViewport.addEventListener('resize', position);
      window.visualViewport.addEventListener('scroll', position);
    }
    this.updateComposer();
  }

  setSession(session) {
    if (session?.key === this.session?.key) return;
    this.session = session;
    this.version = -1;
    this.messages = [];
    this.unread = 0;
    this.sending = false;
    this.pendingRequest = null;
    this.composing = false;
    this.connected = true;
    this.input.value = '';
    this.error.textContent = '';
    this.list.replaceChildren();
    this.toggle(false);
    this.button.hidden = !session;
    this.tabButton.hidden = !session;
    document.querySelector('#chatRoomCode').textContent = session ? `房间 ${session.code}` : '';
    this.updateUnread();
    this.updateComposer();
    this.syncLayout();
  }

  setSidebarTab(tab) {
    this.sidebarTab = tab;
    this.syncLayout();
  }

  syncLayout() {
    const docked = this.desktop.matches;
    const changed = this.docked !== docked;
    const wasOpen = !this.panel.hidden;
    this.docked = docked;
    const parent = docked ? this.sidebar : this.floatingAnchor;
    if (this.panel.parentElement !== parent) parent.append(this.panel);
    this.panel.classList.toggle('is-docked', docked);
    const open = !!this.session && (docked ? this.sidebarTab === 'chat' : !changed && wasOpen);
    this.panel.hidden = !open;
    document.querySelector('#sideContent').hidden = docked && open;
    this.button.setAttribute('aria-expanded', String(open));
    if (open && (!wasOpen || changed)) this.scrollToLatest();
    else this.updateUnread();
  }

  setConnected(connected) {
    this.connected = connected;
    this.updateComposer();
  }

  toggle(open, restoreFocus = false) {
    if (this.docked) return;
    open = !!open && !!this.session;
    this.panel.hidden = !open;
    this.button.setAttribute('aria-expanded', String(open));
    if (open) {
      document.querySelector('#emotePanel').hidden = true;
      document.querySelector('#emoteButton').setAttribute('aria-expanded', 'false');
      this.position?.();
      this.scrollToLatest();
      this.input.focus({ preventScroll: true });
    } else if (restoreFocus) this.button.focus({ preventScroll: true });
  }

  atBottom() {
    return this.list.scrollHeight - this.list.clientHeight - this.list.scrollTop < 36;
  }

  markRead() {
    this.unread = 0;
    this.updateUnread();
  }

  scrollToLatest() {
    this.list.scrollTop = this.list.scrollHeight;
    this.markRead();
  }

  updateUnread() {
    const count = this.unread > 99 ? '99+' : String(this.unread);
    this.badge.hidden = this.unread === 0;
    this.badge.textContent = count;
    this.tabBadge.hidden = this.unread === 0;
    this.tabBadge.textContent = count;
    this.tabButton.setAttribute('aria-label', this.unread ? `聊天，${this.unread} 条未读消息` : '聊天');
    this.button.setAttribute('aria-label', this.unread ? `房间聊天，${this.unread} 条未读消息` : '房间聊天');
    this.newMessages.hidden = !this.unread || this.panel.hidden;
    this.newMessages.textContent = `${count} 条新消息 ↓`;
  }

  apply(chat) {
    if (!this.session || !chat || chat.version <= this.version) return;
    const initial = this.version < 0;
    const previousVersion = this.version;
    const follow = !this.panel.hidden && this.atBottom();
    const scrollTop = this.list.scrollTop;
    if (!initial) this.unread += chat.messages.filter(message => message.id > this.version && !message.own).length;
    this.version = chat.version;
    this.messages = chat.messages;
    const nodes = document.createDocumentFragment();
    if (!chat.messages.length) {
      const empty = document.createElement('li');
      empty.className = 'chat-empty';
      const symbol = document.createElement('span');
      symbol.textContent = '♠';
      symbol.setAttribute('aria-hidden', 'true');
      const title = document.createElement('strong');
      title.textContent = '同桌，也聊两句';
      const hint = document.createElement('p');
      hint.textContent = '打个招呼吧，消息仅在当前房间可见。';
      empty.append(symbol, title, hint);
      nodes.append(empty);
    }
    for (const message of chat.messages.filter(message => message.id > previousVersion)) {
      const item = document.createElement('li');
      item.dataset.messageId = String(message.id);
      item.className = `chat-message${message.own ? ' is-own' : ''}`;
      const meta = document.createElement('div');
      meta.className = 'chat-message-meta';
      const name = document.createElement('strong');
      name.textContent = `${message.name}${message.own ? '（我）' : ''}`;
      meta.append(name);
      if (message.spectator) {
        const role = document.createElement('span');
        role.className = 'chat-role';
        role.textContent = '观战';
        meta.append(role);
      }
      const time = document.createElement('time');
      time.dateTime = new Date(message.time).toISOString();
      time.textContent = new Date(message.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      meta.append(time);
      const text = document.createElement('p');
      // User content always stays text, including markup and URLs.
      text.textContent = message.text;
      item.append(meta, text);
      nodes.append(item);
    }
    if (initial) this.list.replaceChildren(nodes);
    else {
      // Append only new entries so assistive technology does not reread history.
      const oldestId = chat.messages[0]?.id ?? Infinity;
      for (const item of [...this.list.children]) {
        if (!item.dataset.messageId || Number(item.dataset.messageId) < oldestId) item.remove();
      }
      this.list.append(nodes);
    }
    if (follow) this.scrollToLatest();
    else this.list.scrollTop = scrollTop;
    this.updateUnread();
  }

  updateComposer() {
    const length = this.input.value.length;
    document.querySelector('#chatCount').textContent = `${length}/${CHAT_MAX_LENGTH}`;
    this.submit.disabled = !this.session || !this.connected || this.sending || !cleanChatText(this.input.value) || length > CHAT_MAX_LENGTH;
    this.submit.textContent = this.sending ? '发送中…' : '发送';
    document.querySelector('#chatConnection').textContent = this.connected ? '房间内可见 · 免费聊天' : '连接中断，重连后可发送';
  }

  async publish() {
    const text = cleanChatText(this.input.value);
    if (!this.session || !this.connected || this.sending || !text || text.length > CHAT_MAX_LENGTH) return;
    const session = this.session;
    const draft = this.input.value;
    // A failed request keeps its ID so retrying cannot duplicate a delivered message.
    if (this.pendingRequest?.text !== text) this.pendingRequest = { text, requestId: this.requestId() };
    const request = this.pendingRequest;
    this.sending = true;
    this.error.textContent = '';
    this.updateComposer();
    try {
      const chat = await this.send(request);
      if (this.session !== session) return;
      this.apply(chat);
      if (this.input.value === draft) this.input.value = '';
      this.pendingRequest = null;
      this.scrollToLatest();
    } catch (error) {
      if (this.session === session) this.error.textContent = error.message || '发送失败，请重试';
    } finally {
      if (this.session === session) {
        this.sending = false;
        this.updateComposer();
      }
    }
  }
}
