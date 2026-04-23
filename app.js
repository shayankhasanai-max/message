const storage = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
  remove(key) {
    localStorage.removeItem(key);
  }
};

const bus = "BroadcastChannel" in window ? new BroadcastChannel("missile_sync") : null;
const SESSION_KEY = "missile_session_user";
const NOTIF_PROMPTED_KEY = "missile_notif_prompted";

const state = {
  mode: "login",
  activeContactEmail: null,
  pendingMedia: null,
  mobileChatOpen: false,
  notifiedMessages: {},
  processedSignals: new Set(),
  pendingRemoteCandidates: [],
  call: {
    active: false,
    phase: "idle",
    targetEmail: null,
    mediaMode: "audio",
    muted: false,
    statusText: "Idle",
    startedAt: null,
    seconds: 0,
    timerId: null,
    peer: null,
    localStream: null,
    pendingOffer: null
  }
};

const el = {
  authScreen: document.getElementById("authScreen"),
  lockScreen: document.getElementById("lockScreen"),
  chatScreen: document.getElementById("chatScreen"),
  contactsList: document.getElementById("contactsList"),
  activeChatTitle: document.getElementById("activeChatTitle"),
  activeChatSubtitle: document.getElementById("activeChatSubtitle"),
  messages: document.getElementById("messages"),
  contactForm: document.getElementById("contactForm"),
  messageForm: document.getElementById("messageForm"),
  messageInput: document.getElementById("messageInput"),
  mediaInput: document.getElementById("mediaInput"),
  logoutBtn: document.getElementById("logoutBtn"),
  changePinBtn: document.getElementById("changePinBtn"),
  audioCallBtn: document.getElementById("audioCallBtn"),
  videoCallBtn: document.getElementById("videoCallBtn"),
  mobileBackBtn: document.getElementById("mobileBackBtn"),
  callOverlay: document.getElementById("callOverlay"),
  callTypeLabel: document.getElementById("callTypeLabel"),
  callContactName: document.getElementById("callContactName"),
  callStatus: document.getElementById("callStatus"),
  callTimer: document.getElementById("callTimer"),
  callVideoWrap: document.getElementById("callVideoWrap"),
  localVideo: document.getElementById("localVideo"),
  remoteVideo: document.getElementById("remoteVideo"),
  muteCallBtn: document.getElementById("muteCallBtn"),
  endCallBtn: document.getElementById("endCallBtn"),
  acceptCallBtn: document.getElementById("acceptCallBtn"),
  declineCallBtn: document.getElementById("declineCallBtn"),
  remoteAudio: document.getElementById("remoteAudio")
};

function setSessionUser(email) {
  const payload = { email };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  storage.set("currentUser", payload);
}

function currentUser() {
  const fromSession = sessionStorage.getItem(SESSION_KEY);
  if (fromSession) {
    try {
      return JSON.parse(fromSession);
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }

  const fallback = storage.get("currentUser", null);
  if (fallback?.email) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(fallback));
    return fallback;
  }
  return null;
}

function allUsers() {
  return storage.get("users", []);
}

function contactKey(email) {
  return `contacts_${email}`;
}

function blockedKey(email) {
  return `blocked_${email}`;
}

function messagesKey(a, b) {
  const [x, y] = [a, b].sort();
  return `messages_${x}_${y}`;
}

function signalKey(a, b) {
  const [x, y] = [a, b].sort();
  return `call_signals_${x}_${y}`;
}

function getContacts(owner) {
  return storage.get(contactKey(owner), []);
}

function setContacts(owner, contacts) {
  storage.set(contactKey(owner), contacts);
}

function getBlocked(owner) {
  return storage.get(blockedKey(owner), []);
}

function setBlocked(owner, list) {
  storage.set(blockedKey(owner), list);
}

function isBlockedBy(owner, target) {
  return getBlocked(owner).includes(target);
}

function getMessages(a, b) {
  return storage.get(messagesKey(a, b), []);
}

function setMessages(a, b, list) {
  storage.set(messagesKey(a, b), list);
}

function getSignals(a, b) {
  return storage.get(signalKey(a, b), []);
}

function setSignals(a, b, list) {
  storage.set(signalKey(a, b), list.slice(-500));
}

function ensureContact(ownerEmail, targetEmail, preferredName = "") {
  if (!ownerEmail || !targetEmail || ownerEmail === targetEmail) return;
  const contacts = getContacts(ownerEmail);
  if (contacts.some((c) => c.email === targetEmail)) return;
  const user = allUsers().find((u) => u.email === targetEmail);
  contacts.push({ name: preferredName || user?.name || targetEmail, email: targetEmail });
  setContacts(ownerEmail, contacts);
}

function isMobileView() {
  return window.matchMedia("(max-width: 860px)").matches;
}

function updateMobileLayout() {
  const listOpen = isMobileView() && !state.mobileChatOpen;
  const chatOpen = isMobileView() && state.mobileChatOpen;
  el.chatScreen.classList.toggle("mobile-list-open", listOpen);
  el.chatScreen.classList.toggle("mobile-chat-open", chatOpen);
  el.mobileBackBtn.classList.toggle("hidden", !chatOpen);
}

function getDisplayName(owner, target) {
  const contacts = getContacts(owner);
  const contact = contacts.find((c) => c.email === target);
  if (contact?.name) return contact.name;
  const user = allUsers().find((u) => u.email === target);
  return user?.name || target;
}

function notificationsSupported() {
  return "Notification" in window;
}

function askNotificationPermissionFirstTime() {
  if (!notificationsSupported()) return;
  if (storage.get(NOTIF_PROMPTED_KEY, false)) return;
  storage.set(NOTIF_PROMPTED_KEY, true);
  if (Notification.permission !== "default") return;
  setTimeout(() => {
    const ok = confirm("Missile wants notifications for messages and calls. Enable?");
    if (ok) Notification.requestPermission();
  }, 350);
}

function showNotification(title, body) {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body });
  } catch {
    // no-op
  }
}

function notifySync(type, payload = {}) {
  const detail = { type, payload, at: Date.now(), id: `${Date.now()}_${Math.random()}` };
  if (bus) bus.postMessage(detail);
  localStorage.setItem("missile_sync_event", JSON.stringify(detail));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function newestMessageTimestamp(selfEmail, otherEmail) {
  const list = getMessages(selfEmail, otherEmail);
  if (!list.length) return "";
  return list[list.length - 1].timestamp || "";
}

function initNotificationBaseline() {
  const session = currentUser();
  if (!session) return;
  allUsers().forEach((u) => {
    if (u.email === session.email) return;
    state.notifiedMessages[messagesKey(session.email, u.email)] = newestMessageTimestamp(session.email, u.email);
  });
}

function checkIncomingMessageNotifications() {
  const session = currentUser();
  if (!session) return;

  allUsers().forEach((u) => {
    if (u.email === session.email) return;
    if (isBlockedBy(session.email, u.email)) return;

    const key = messagesKey(session.email, u.email);
    const list = getMessages(session.email, u.email);
    if (!list.length) return;
    const latest = list[list.length - 1];
    const previous = state.notifiedMessages[key] || "";
    if (latest.timestamp !== previous) {
      state.notifiedMessages[key] = latest.timestamp;
      if (latest.sender !== session.email && document.visibilityState !== "visible") {
        showNotification(getDisplayName(session.email, u.email), latest.text || "[Media]");
      }
    }
  });
}

function getKnownPeople(selfEmail) {
  const map = new Map();
  getContacts(selfEmail).forEach((c) => map.set(c.email, { ...c, isContact: true }));

  allUsers().forEach((u) => {
    if (u.email === selfEmail) return;
    if (getMessages(selfEmail, u.email).length > 0 && !map.has(u.email)) {
      map.set(u.email, {
        email: u.email,
        name: u.name || u.email,
        isContact: false
      });
    }
  });

  return Array.from(map.values());
}

function getActiveContact() {
  const session = currentUser();
  if (!session) return null;
  return getKnownPeople(session.email).find((p) => p.email === state.activeContactEmail) || null;
}

function openChat(email) {
  state.activeContactEmail = email;
  if (isMobileView()) state.mobileChatOpen = true;
  renderContacts();
  renderMessages();
  updateMobileLayout();
  renderCallOverlay();
}

function goBackToContacts() {
  state.mobileChatOpen = false;
  updateMobileLayout();
}

function renderAuth() {
  el.authScreen.classList.remove("hidden");
  el.lockScreen.classList.add("hidden");
  el.chatScreen.classList.add("hidden");

  const isSignup = state.mode === "signup";
  el.authScreen.innerHTML = `
    <div class="card auth-card">
      <h2>${isSignup ? "Create account" : "Welcome back"}</h2>
      <p class="meta">${isSignup ? "Sign up to start messaging" : "Log in to continue"}</p>
      <form id="authForm" class="stack">
        ${
          isSignup
            ? `<input id="signupName" type="text" placeholder="Name" required />
               <input id="signupPin" type="password" placeholder="4-digit PIN" maxlength="4" required />`
            : ""
        }
        <input id="authEmail" type="email" placeholder="Email" required />
        <input id="authPassword" type="password" placeholder="Password" required />
        <button class="btn" type="submit">${isSignup ? "Sign up" : "Login"}</button>
      </form>

      <section id="googlePanel" class="google-panel hidden">
        <p class="meta">Quick Google setup</p>
        <p class="google-note">No password needed for Google sign in.</p>
        <input id="googleEmailInput" type="email" placeholder="Google email" />
        <input id="googleNameInput" type="text" placeholder="Full name (new account only)" />
        <input id="googlePinInput" type="password" maxlength="4" placeholder="4-digit PIN (new account only)" />
        <div class="google-panel-actions">
          <button id="googleSubmitBtn" class="btn" type="button">Continue</button>
          <button id="googleCancelBtn" class="btn btn-ghost" type="button">Cancel</button>
        </div>
        <p id="googleError" class="error"></p>
      </section>

      <div class="google-row">
        <button id="googleAuthBtn" class="google-btn-fallback" type="button"><span>G</span> Continue with Google</button>
      </div>

      <p id="authError" class="error"></p>
      <p class="meta">
        ${isSignup ? "Already have an account?" : "New to Missile?"}
        <button id="toggleAuth" type="button" class="auth-toggle">${isSignup ? "Login" : "Sign up"}</button>
      </p>
    </div>
  `;

  document.getElementById("toggleAuth").onclick = () => {
    state.mode = isSignup ? "login" : "signup";
    renderAuth();
  };

  const googlePanel = document.getElementById("googlePanel");
  const googleEmailInput = document.getElementById("googleEmailInput");
  const googleNameInput = document.getElementById("googleNameInput");
  const googlePinInput = document.getElementById("googlePinInput");
  const googleSubmitBtn = document.getElementById("googleSubmitBtn");
  const googleCancelBtn = document.getElementById("googleCancelBtn");
  const googleError = document.getElementById("googleError");

  document.getElementById("googleAuthBtn").onclick = () => {
    googlePanel.classList.remove("hidden");
    googleError.textContent = "";
    googleEmailInput.focus();
  };

  googleCancelBtn.onclick = () => {
    googlePanel.classList.add("hidden");
    googleError.textContent = "";
  };

  googleSubmitBtn.onclick = () => {
    googleError.textContent = "";
    const email = googleEmailInput.value.trim().toLowerCase();
    const name = googleNameInput.value.trim();
    const pin = googlePinInput.value.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      googleError.textContent = "Enter a valid Google email.";
      googleEmailInput.focus();
      return;
    }

    const users = allUsers();
    let user = users.find((u) => u.email === email);

    if (!user) {
      if (!name) {
        googleError.textContent = "Name is required for new Google account.";
        googleNameInput.focus();
        return;
      }
      if (!/^\d{4}$/.test(pin)) {
        googleError.textContent = "PIN must be exactly 4 digits.";
        googlePinInput.focus();
        return;
      }

      user = { name, email, password: "google-auth", pin, provider: "google" };
      users.push(user);
      storage.set("users", users);
      setContacts(email, []);
      setBlocked(email, []);
      notifySync("auth");
    }

    setSessionUser(email);
    renderLock();
  };

  document.getElementById("authForm").onsubmit = (event) => {
    event.preventDefault();
    const authError = document.getElementById("authError");
    authError.textContent = "";

    const email = document.getElementById("authEmail").value.trim().toLowerCase();
    const password = document.getElementById("authPassword").value;

    if (isSignup) {
      const name = document.getElementById("signupName").value.trim();
      const pin = document.getElementById("signupPin").value.trim();

      if (!/^\d{4}$/.test(pin)) {
        authError.textContent = "PIN must be exactly 4 digits.";
        return;
      }

      const users = allUsers();
      if (users.some((u) => u.email === email)) {
        authError.textContent = "Email already exists.";
        return;
      }

      users.push({ name, email, password, pin });
      storage.set("users", users);
      setContacts(email, []);
      setBlocked(email, []);
      setSessionUser(email);
      notifySync("auth");
      renderLock();
      return;
    }

    const user = allUsers().find((u) => u.email === email && u.password === password);
    if (!user) {
      authError.textContent = "Invalid email or password.";
      return;
    }

    setSessionUser(email);
    renderLock();
  };
}

function renderLock() {
  const session = currentUser();
  if (!session) return renderAuth();

  askNotificationPermissionFirstTime();
  initNotificationBaseline();

  const user = allUsers().find((u) => u.email === session.email);
  if (!user) return logout();

  el.authScreen.classList.add("hidden");
  el.lockScreen.classList.remove("hidden");
  el.chatScreen.classList.add("hidden");

  el.lockScreen.innerHTML = `
    <div class="card lock-card">
      <h2>App Locked</h2>
      <p class="meta">Enter PIN for ${user.email}</p>
      <form id="unlockForm" class="stack">
        <input id="unlockPin" type="password" placeholder="4-digit PIN" maxlength="4" required />
        <button class="btn" type="submit">Unlock</button>
      </form>
      <p id="lockError" class="error"></p>
    </div>
  `;

  document.getElementById("unlockForm").onsubmit = (event) => {
    event.preventDefault();
    const pin = document.getElementById("unlockPin").value.trim();
    const err = document.getElementById("lockError");
    if (pin !== user.pin) {
      err.textContent = "Incorrect PIN.";
      return;
    }
    renderChatApp();
  };
}

function ensureHeaderUtilityButtons() {
  const headerActions = document.querySelector(".header-actions");
  if (!headerActions) return;

  if (!document.getElementById("addKnownBtn")) {
    const addBtn = document.createElement("button");
    addBtn.id = "addKnownBtn";
    addBtn.type = "button";
    addBtn.className = "btn btn-ghost hidden";
    addBtn.textContent = "Add Contact";
    headerActions.appendChild(addBtn);
    addBtn.addEventListener("click", addActiveToContacts);
  }

  if (!document.getElementById("blockBtn")) {
    const blockBtn = document.createElement("button");
    blockBtn.id = "blockBtn";
    blockBtn.type = "button";
    blockBtn.className = "btn btn-ghost hidden";
    blockBtn.textContent = "Block";
    headerActions.appendChild(blockBtn);
    blockBtn.addEventListener("click", toggleBlockActiveContact);
  }
}

function renderContacts() {
  const session = currentUser();
  if (!session) return;

  const people = getKnownPeople(session.email)
    .filter((p) => !isBlockedBy(session.email, p.email))
    .sort((a, b) => {
      const ta = newestMessageTimestamp(session.email, a.email);
      const tb = newestMessageTimestamp(session.email, b.email);
      return tb.localeCompare(ta);
    });

  if (!people.length) {
    el.contactsList.innerHTML = '<p class="empty">No chats yet.</p>';
    return;
  }

  el.contactsList.innerHTML = people.map((person) => {
    const last = getMessages(session.email, person.email).slice(-1)[0];
    const preview = last ? (last.text || "[Media]") : (person.isContact ? "Tap to start chatting" : "New chat");
    return `
      <article class="contact-item ${state.activeContactEmail === person.email ? "active" : ""}" data-email="${person.email}">
        <div class="contact-top">
          <h3>${escapeHtml(person.name)}</h3>
          <span class="meta">${last ? new Date(last.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
        </div>
        <div class="meta contact-sub">${escapeHtml(preview)}</div>
      </article>
    `;
  }).join("");

  el.contactsList.querySelectorAll(".contact-item").forEach((item) => {
    item.addEventListener("click", () => openChat(item.dataset.email));
  });
}

function addActiveToContacts() {
  const session = currentUser();
  const active = getActiveContact();
  if (!session || !active) return;

  if (getContacts(session.email).some((c) => c.email === active.email)) return;
  ensureContact(session.email, active.email, active.name);
  renderContacts();
  renderMessages();
  notifySync("contacts", { owner: session.email });
}

function toggleBlockActiveContact() {
  const session = currentUser();
  const active = getActiveContact();
  if (!session || !active) return;

  const list = getBlocked(session.email);
  const idx = list.indexOf(active.email);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.push(active.email);
    if (state.call.active && state.call.targetEmail === active.email) {
      endCall(true);
    }
  }

  setBlocked(session.email, list);
  renderContacts();
  renderMessages();
  notifySync("block", { owner: session.email, target: active.email });
}

function renderMessages() {
  const session = currentUser();
  if (!session) return;

  const active = getActiveContact();
  const addBtn = document.getElementById("addKnownBtn");
  const blockBtn = document.getElementById("blockBtn");

  if (!active) {
    state.mobileChatOpen = false;
    el.activeChatTitle.textContent = "Select a chat";
    el.activeChatSubtitle.textContent = "No chat selected";
    el.messages.innerHTML = '<p class="empty">Choose a contact or wait for new messages.</p>';
    if (addBtn) addBtn.classList.add("hidden");
    if (blockBtn) blockBtn.classList.add("hidden");
    el.messageInput.disabled = true;
    return;
  }

  const inContacts = getContacts(session.email).some((c) => c.email === active.email);
  const blocked = isBlockedBy(session.email, active.email);

  if (addBtn) {
    addBtn.classList.toggle("hidden", inContacts);
  }
  if (blockBtn) {
    blockBtn.classList.remove("hidden");
    blockBtn.textContent = blocked ? "Unblock" : "Block";
  }

  el.activeChatTitle.textContent = getDisplayName(session.email, active.email);
  el.activeChatSubtitle.textContent = active.email;

  const list = getMessages(session.email, active.email);
  if (!list.length) {
    el.messages.innerHTML = '<p class="empty">No messages yet.</p>';
  } else {
    el.messages.innerHTML = list.map((m) => {
      const bubble = m.sender === session.email ? "sent" : "received";
      const media = m.type === "media" && m.media
        ? `<div class="media-chip">${escapeHtml(m.media.name)} (${escapeHtml(m.media.mime || "file")})</div>`
        : "";
      return `
        <div class="message ${bubble}">
          <div>${escapeHtml(m.text || "[Media]")}</div>
          ${media}
          <div class="time">${new Date(m.timestamp).toLocaleString()}</div>
        </div>
      `;
    }).join("");
  }

  if (blocked) {
    el.messages.insertAdjacentHTML("beforeend", '<p class="empty">You blocked this user. Unblock to send/receive.</p>');
  }

  el.messageInput.disabled = blocked;
  el.messages.scrollTop = el.messages.scrollHeight;
}

function renderChatApp() {
  const session = currentUser();
  if (!session) return renderAuth();

  el.authScreen.classList.add("hidden");
  el.lockScreen.classList.add("hidden");
  el.chatScreen.classList.remove("hidden");

  ensureHeaderUtilityButtons();

  const people = getKnownPeople(session.email).filter((p) => !isBlockedBy(session.email, p.email));
  if (!state.activeContactEmail && people.length && !isMobileView()) {
    state.activeContactEmail = people[0].email;
  }

  state.mobileChatOpen = isMobileView() ? false : !!state.activeContactEmail;

  renderContacts();
  renderMessages();
  updateMobileLayout();
  renderCallOverlay();
  processSignals();
}

function addContact(event) {
  event.preventDefault();
  const session = currentUser();
  if (!session) return;

  const nameInput = document.getElementById("contactName");
  const emailInput = document.getElementById("contactEmail");
  const name = nameInput.value.trim();
  const email = emailInput.value.trim().toLowerCase();

  if (!name || !email) return;
  if (email === session.email) {
    alert("You cannot add yourself.");
    return;
  }
  if (getContacts(session.email).some((c) => c.email === email)) {
    alert("Contact already exists.");
    return;
  }

  const contacts = getContacts(session.email);
  contacts.push({ name, email });
  setContacts(session.email, contacts);

  nameInput.value = "";
  emailInput.value = "";

  if (!state.activeContactEmail) state.activeContactEmail = email;
  renderContacts();
  renderMessages();
  notifySync("contacts", { owner: session.email });
}

function setMediaPreview(file) {
  const old = document.getElementById("pendingMediaPreview");
  if (old) old.remove();
  if (!file) return;

  const wrapper = document.createElement("div");
  wrapper.id = "pendingMediaPreview";
  wrapper.className = "inline-preview";
  wrapper.innerHTML = `<strong>Pending media:</strong> ${escapeHtml(file.name)}`;

  if (file.type.startsWith("image/")) {
    const img = document.createElement("img");
    img.alt = "Preview";
    img.src = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(img.src);
    wrapper.appendChild(img);
  }

  el.messageForm.insertAdjacentElement("beforebegin", wrapper);
}

function sendMessage(event) {
  event.preventDefault();
  const session = currentUser();
  const active = getActiveContact();
  if (!session || !active) return;

  if (isBlockedBy(session.email, active.email)) {
    alert("Unblock this user to send messages.");
    return;
  }
  if (isBlockedBy(active.email, session.email)) {
    alert("This user blocked you. Message not delivered.");
    return;
  }

  const text = el.messageInput.value.trim();
  const hasMedia = !!state.pendingMedia;
  if (!text && !hasMedia) return;

  const list = getMessages(session.email, active.email);
  list.push({
    text: text || "[Media]",
    type: hasMedia ? "media" : "text",
    sender: session.email,
    timestamp: new Date().toISOString(),
    media: hasMedia ? {
      name: state.pendingMedia.name,
      mime: state.pendingMedia.type || "unknown",
      size: state.pendingMedia.size
    } : null
  });

  setMessages(session.email, active.email, list);

  el.messageInput.value = "";
  el.mediaInput.value = "";
  state.pendingMedia = null;
  setMediaPreview(null);

  renderMessages();
  renderContacts();
  notifySync("message", { conversation: messagesKey(session.email, active.email) });
}

function changePin() {
  const session = currentUser();
  if (!session) return;
  const users = allUsers();
  const idx = users.findIndex((u) => u.email === session.email);
  if (idx < 0) return;

  const current = prompt("Enter current PIN:");
  if (!current) return;
  if (users[idx].pin !== current.trim()) {
    alert("Current PIN is incorrect.");
    return;
  }

  const next = prompt("Enter new 4-digit PIN:");
  if (!next || !/^\d{4}$/.test(next.trim())) {
    alert("New PIN must be 4 digits.");
    return;
  }

  users[idx].pin = next.trim();
  storage.set("users", users);
  alert("PIN updated.");
}

function formatDuration(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function clearCallTimer() {
  if (state.call.timerId) clearInterval(state.call.timerId);
  state.call.timerId = null;
}

function closePeer() {
  if (state.call.peer) {
    state.call.peer.onicecandidate = null;
    state.call.peer.ontrack = null;
    state.call.peer.onconnectionstatechange = null;
    state.call.peer.close();
  }
  state.call.peer = null;

  if (state.call.localStream) {
    state.call.localStream.getTracks().forEach((t) => t.stop());
  }

  state.call.localStream = null;
  state.pendingRemoteCandidates = [];

  el.remoteAudio.srcObject = null;
  if (el.remoteVideo) el.remoteVideo.srcObject = null;
  if (el.localVideo) el.localVideo.srcObject = null;
}

function resetCallState() {
  clearCallTimer();
  closePeer();
  state.call.active = false;
  state.call.phase = "idle";
  state.call.targetEmail = null;
  state.call.mediaMode = "audio";
  state.call.muted = false;
  state.call.statusText = "Idle";
  state.call.startedAt = null;
  state.call.seconds = 0;
  state.call.pendingOffer = null;
}

function renderCallOverlay() {
  const session = currentUser();
  const active = getActiveContact();
  const canStart = !!session && !!active && !state.call.active && !isBlockedBy(session?.email || "", active?.email || "");

  el.audioCallBtn.disabled = !canStart;
  if (el.videoCallBtn) el.videoCallBtn.disabled = !canStart;

  if (!state.call.active) {
    el.callOverlay.classList.add("hidden");
    return;
  }

  el.callOverlay.classList.remove("hidden");
  el.callTypeLabel.textContent = state.call.mediaMode === "video" ? "Missile Video Call" : "Missile Audio Call";
  const contactEmail = state.call.targetEmail || active?.email;
  el.callContactName.textContent = contactEmail && session ? getDisplayName(session.email, contactEmail) : "Unknown";
  el.callStatus.textContent = state.call.statusText;
  el.callTimer.textContent = formatDuration(state.call.seconds);
  el.muteCallBtn.textContent = state.call.muted ? "Unmute" : "Mute";

  const incoming = state.call.phase === "incoming";
  const connected = state.call.phase === "connected";

  el.acceptCallBtn.classList.toggle("hidden", !incoming);
  el.declineCallBtn.classList.toggle("hidden", !incoming);
  el.muteCallBtn.classList.toggle("hidden", incoming);
  el.endCallBtn.classList.toggle("hidden", incoming);
  el.muteCallBtn.disabled = !connected;

  if (el.callVideoWrap) {
    el.callVideoWrap.classList.toggle("hidden", state.call.mediaMode !== "video");
  }
}

function publishSignal(targetEmail, type, payload = {}) {
  const session = currentUser();
  if (!session) return;

  const list = getSignals(session.email, targetEmail);
  list.push({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`,
    from: session.email,
    to: targetEmail,
    type,
    payload,
    timestamp: Date.now()
  });
  setSignals(session.email, targetEmail, list);
  notifySync("signal", { pair: signalKey(session.email, targetEmail) });
}

function ensurePeer(targetEmail) {
  if (state.call.peer) return state.call.peer;

  const peer = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  peer.onicecandidate = (event) => {
    if (event.candidate) publishSignal(targetEmail, "candidate", event.candidate);
  };

  peer.ontrack = (event) => {
    const [stream] = event.streams;
    if (!stream) return;
    el.remoteAudio.srcObject = stream;
    if (state.call.mediaMode === "video" && el.remoteVideo) {
      el.remoteVideo.srcObject = stream;
    }
  };

  peer.onconnectionstatechange = () => {
    if (["disconnected", "failed", "closed"].includes(peer.connectionState)) {
      endCall(false);
    }
  };

  state.call.peer = peer;
  return peer;
}

async function ensureLocalMedia(mode) {
  if (state.call.localStream) {
    const hasVideo = state.call.localStream.getVideoTracks().length > 0;
    if ((mode === "video" && hasVideo) || (mode === "audio" && !hasVideo)) {
      return state.call.localStream;
    }
    state.call.localStream.getTracks().forEach((t) => t.stop());
    state.call.localStream = null;
  }

  const stream = await navigator.mediaDevices.getUserMedia(
    mode === "video" ? { audio: true, video: { facingMode: "user" } } : { audio: true, video: false }
  );

  state.call.localStream = stream;
  if (el.localVideo) {
    el.localVideo.srcObject = mode === "video" ? stream : null;
  }
  return stream;
}

function startCallTimer() {
  clearCallTimer();
  state.call.startedAt = Date.now();
  state.call.seconds = 0;
  state.call.timerId = setInterval(() => {
    state.call.seconds = Math.floor((Date.now() - state.call.startedAt) / 1000);
    el.callTimer.textContent = formatDuration(state.call.seconds);
  }, 1000);
}

async function startCall(mode) {
  const session = currentUser();
  const active = getActiveContact();
  if (!session || !active || state.call.active) return;

  if (isBlockedBy(session.email, active.email) || isBlockedBy(active.email, session.email)) {
    alert("Call not allowed. One side has blocked the other.");
    return;
  }

  try {
    state.call.active = true;
    state.call.phase = "outgoing";
    state.call.targetEmail = active.email;
    state.call.mediaMode = mode;
    state.call.statusText = mode === "video" ? "Starting video call..." : "Calling...";
    renderCallOverlay();

    const stream = await ensureLocalMedia(mode);
    const peer = ensurePeer(active.email);
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    publishSignal(active.email, "offer", { sdp: offer, mode });
  } catch {
    alert("Unable to start call. Check mic/camera permission.");
    resetCallState();
    renderCallOverlay();
  }
}

async function startAudioCall() {
  await startCall("audio");
}

async function startVideoCall() {
  await startCall("video");
}

async function acceptIncomingCall() {
  if (state.call.phase !== "incoming" || !state.call.pendingOffer || !state.call.targetEmail) return;

  try {
    const stream = await ensureLocalMedia(state.call.mediaMode || "audio");
    const peer = ensurePeer(state.call.targetEmail);
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));

    await peer.setRemoteDescription(new RTCSessionDescription(state.call.pendingOffer));
    for (const cand of state.pendingRemoteCandidates) {
      await peer.addIceCandidate(new RTCIceCandidate(cand));
    }
    state.pendingRemoteCandidates = [];

    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    publishSignal(state.call.targetEmail, "answer", { sdp: answer });

    state.call.phase = "connected";
    state.call.statusText = "Connected";
    startCallTimer();
    renderCallOverlay();
  } catch {
    alert("Failed to accept call.");
    declineIncomingCall();
  }
}

function declineIncomingCall() {
  if (!state.call.targetEmail) return;
  publishSignal(state.call.targetEmail, "reject", {});
  resetCallState();
  renderCallOverlay();
}

function toggleMuteCall() {
  if (!state.call.localStream || !state.call.active) return;
  state.call.muted = !state.call.muted;
  state.call.localStream.getAudioTracks().forEach((t) => {
    t.enabled = !state.call.muted;
  });
  renderCallOverlay();
}

function endCall(sendSignal = true) {
  if (!state.call.active) return;
  if (sendSignal && state.call.targetEmail) {
    publishSignal(state.call.targetEmail, "end", { duration: state.call.seconds });
  }
  resetCallState();
  renderCallOverlay();
}

async function handleSignal(signal) {
  if (state.processedSignals.has(signal.id)) return;
  state.processedSignals.add(signal.id);

  const session = currentUser();
  if (!session || signal.to !== session.email) return;

  if (signal.type === "offer") {
    if (state.call.active) {
      publishSignal(signal.from, "reject", { reason: "busy" });
      return;
    }

    if (isBlockedBy(session.email, signal.from) || isBlockedBy(signal.from, session.email)) {
      publishSignal(signal.from, "reject", { reason: "blocked" });
      return;
    }

    const offerPayload = signal.payload || {};
    state.call.active = true;
    state.call.phase = "incoming";
    state.call.targetEmail = signal.from;
    state.call.mediaMode = offerPayload.mode === "video" ? "video" : "audio";
    state.call.pendingOffer = offerPayload.sdp || offerPayload;
    state.call.statusText = `Incoming ${state.call.mediaMode} call from ${getDisplayName(session.email, signal.from)}`;

    if (document.visibilityState !== "visible") {
      showNotification(`Incoming ${state.call.mediaMode} call`, `From ${getDisplayName(session.email, signal.from)}`);
    }

    if (!state.activeContactEmail) state.activeContactEmail = signal.from;
    renderContacts();
    renderMessages();
    renderCallOverlay();
    return;
  }

  if (!state.call.active || state.call.targetEmail !== signal.from) return;
  const peer = state.call.peer;

  if (signal.type === "answer" && peer) {
    await peer.setRemoteDescription(new RTCSessionDescription(signal.payload?.sdp || signal.payload));
    for (const cand of state.pendingRemoteCandidates) {
      await peer.addIceCandidate(new RTCIceCandidate(cand));
    }
    state.pendingRemoteCandidates = [];
    state.call.phase = "connected";
    state.call.statusText = "Connected";
    startCallTimer();
    renderCallOverlay();
    return;
  }

  if (signal.type === "candidate") {
    if (peer && peer.remoteDescription) {
      await peer.addIceCandidate(new RTCIceCandidate(signal.payload));
    } else {
      state.pendingRemoteCandidates.push(signal.payload);
    }
    return;
  }

  if (signal.type === "reject") {
    alert("Call declined or unavailable.");
    resetCallState();
    renderCallOverlay();
    return;
  }

  if (signal.type === "end") {
    resetCallState();
    renderCallOverlay();
  }
}

async function processSignals() {
  const session = currentUser();
  if (!session) return;

  for (const user of allUsers()) {
    if (user.email === session.email) continue;
    const list = getSignals(session.email, user.email);
    for (const signal of list) {
      await handleSignal(signal);
    }
  }
}

function logout() {
  endCall(false);
  sessionStorage.removeItem(SESSION_KEY);
  storage.remove("currentUser");
  state.activeContactEmail = null;
  state.pendingMedia = null;
  renderAuth();
  updateMobileLayout();
  renderCallOverlay();
}

function onExternalSync() {
  if (!currentUser()) return;
  checkIncomingMessageNotifications();
  renderContacts();
  renderMessages();
  updateMobileLayout();
  renderCallOverlay();
  processSignals();
}

function boot() {
  el.contactForm.addEventListener("submit", addContact);
  el.messageForm.addEventListener("submit", sendMessage);
  el.logoutBtn.addEventListener("click", logout);
  el.changePinBtn.addEventListener("click", changePin);
  el.audioCallBtn.addEventListener("click", startAudioCall);
  if (el.videoCallBtn) el.videoCallBtn.addEventListener("click", startVideoCall);
  el.muteCallBtn.addEventListener("click", toggleMuteCall);
  el.endCallBtn.addEventListener("click", () => endCall(true));
  el.acceptCallBtn.addEventListener("click", acceptIncomingCall);
  el.declineCallBtn.addEventListener("click", declineIncomingCall);
  el.mobileBackBtn.addEventListener("click", goBackToContacts);

  el.mediaInput.addEventListener("change", (event) => {
    const file = event.target.files?.[0] || null;
    state.pendingMedia = file;
    setMediaPreview(file);
  });

  if (bus) bus.onmessage = () => onExternalSync();

  window.addEventListener("resize", updateMobileLayout);
  window.addEventListener("storage", (event) => {
    if (!event.key) return;
    if (
      event.key.startsWith("messages_") ||
      event.key.startsWith("contacts_") ||
      event.key.startsWith("blocked_") ||
      event.key.startsWith("call_signals_") ||
      event.key === "missile_sync_event"
    ) {
      onExternalSync();
    }
  });

  if (currentUser()) {
    initNotificationBaseline();
    askNotificationPermissionFirstTime();
    renderLock();
  } else {
    renderAuth();
  }

  updateMobileLayout();
  renderCallOverlay();
}

boot();
