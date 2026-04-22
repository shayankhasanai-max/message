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
const NOTIF_PROMPTED_KEY = "missile_notif_prompted";

const state = {
  mode: "login",
  activeContactEmail: null,
  pendingMedia: null,
  notifiedMessages: {},
  processedSignals: new Set(),
  pendingRemoteCandidates: [],
  call: {
    active: false,
    muted: false,
    phase: "idle", // idle | incoming | outgoing | connected
    targetEmail: null,
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
  callOverlay: document.getElementById("callOverlay"),
  callContactName: document.getElementById("callContactName"),
  callStatus: document.getElementById("callStatus"),
  callTimer: document.getElementById("callTimer"),
  muteCallBtn: document.getElementById("muteCallBtn"),
  endCallBtn: document.getElementById("endCallBtn"),
  acceptCallBtn: document.getElementById("acceptCallBtn"),
  declineCallBtn: document.getElementById("declineCallBtn"),
  remoteAudio: document.getElementById("remoteAudio")
};

const SESSION_KEY = "missile_session_user";

function setSessionUser(email) {
  const session = { email };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  storage.set("currentUser", session);
}

function currentUser() {
  const session = sessionStorage.getItem(SESSION_KEY);
  if (session) {
    try {
      return JSON.parse(session);
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

function notificationsSupported() {
  return "Notification" in window;
}

function askNotificationPermissionFirstTime() {
  if (!notificationsSupported()) return;
  if (storage.get(NOTIF_PROMPTED_KEY, false)) return;
  storage.set(NOTIF_PROMPTED_KEY, true);

  if (Notification.permission !== "default") return;

  // Ask once on first use.
  setTimeout(() => {
    const allow = confirm("Missile would like to show notifications for new messages and calls. Enable now?");
    if (allow) {
      Notification.requestPermission();
    }
  }, 500);
}

function showNotification(title, body) {
  if (!notificationsSupported()) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body });
  } catch {
    // Ignore notification errors.
  }
}

function contactKey(userEmail) {
  return `contacts_${userEmail}`;
}

function messagesKey(userEmail, contactEmail) {
  const [a, b] = [userEmail, contactEmail].sort();
  return `messages_${a}_${b}`;
}

function signalKey(userEmail, contactEmail) {
  const [a, b] = [userEmail, contactEmail].sort();
  return `call_signals_${a}_${b}`;
}

function getContacts(userEmail) {
  return storage.get(contactKey(userEmail), []);
}

function setContacts(userEmail, contacts) {
  storage.set(contactKey(userEmail), contacts);
}

function getMessages(userEmail, contactEmail) {
  return storage.get(messagesKey(userEmail, contactEmail), []);
}

function setMessages(userEmail, contactEmail, messages) {
  storage.set(messagesKey(userEmail, contactEmail), messages);
}

function getSignals(userEmail, contactEmail) {
  return storage.get(signalKey(userEmail, contactEmail), []);
}

function setSignals(userEmail, contactEmail, signals) {
  storage.set(signalKey(userEmail, contactEmail), signals.slice(-400));
}

function ensureContact(ownerEmail, targetEmail, preferredName = "") {
  if (!ownerEmail || !targetEmail || ownerEmail === targetEmail) return;
  const contacts = getContacts(ownerEmail);
  if (contacts.some((c) => c.email === targetEmail)) return;

  const user = allUsers().find((u) => u.email === targetEmail);
  contacts.push({
    name: preferredName || user?.name || targetEmail,
    email: targetEmail
  });
  setContacts(ownerEmail, contacts);
}

function syncKnownConversationsAsContacts() {
  const session = currentUser();
  if (!session) return;

  const users = allUsers().filter((u) => u.email !== session.email);
  users.forEach((u) => {
    if (getMessages(session.email, u.email).length) {
      ensureContact(session.email, u.email, u.name);
    }
  });
}

function newestMessageTimestamp(userEmail, contactEmail) {
  const messages = getMessages(userEmail, contactEmail);
  if (!messages.length) return "";
  return messages[messages.length - 1].timestamp || "";
}

function initNotificationBaseline() {
  const session = currentUser();
  if (!session) return;

  const users = allUsers().filter((u) => u.email !== session.email);
  for (const u of users) {
    const key = messagesKey(session.email, u.email);
    state.notifiedMessages[key] = newestMessageTimestamp(session.email, u.email);
  }
}

function checkIncomingMessageNotifications() {
  const session = currentUser();
  if (!session) return;

  const users = allUsers().filter((u) => u.email !== session.email);
  for (const u of users) {
    const key = messagesKey(session.email, u.email);
    const messages = getMessages(session.email, u.email);
    if (!messages.length) continue;

    const latest = messages[messages.length - 1];
    const previousTs = state.notifiedMessages[key] || "";

    if (latest.timestamp !== previousTs) {
      state.notifiedMessages[key] = latest.timestamp;
      const isIncoming = latest.sender !== session.email;
      if (isIncoming && document.visibilityState !== "visible") {
        showNotification(getDisplayNameForEmail(session.email, u.email), latest.text || "[Media]");
      }
    }
  }
}

function getDisplayNameForEmail(ownerEmail, targetEmail) {
  const contacts = getContacts(ownerEmail);
  const inContacts = contacts.find((c) => c.email === targetEmail);
  if (inContacts?.name) return inContacts.name;

  const user = allUsers().find((u) => u.email === targetEmail);
  return user?.name || targetEmail;
}

function getActiveContact() {
  const session = currentUser();
  if (!session) return null;
  return getContacts(session.email).find((c) => c.email === state.activeContactEmail) || null;
}

function notifySync(type, payload = {}) {
  const detail = { type, payload, at: Date.now(), id: `${Date.now()}_${Math.random()}` };
  if (bus) bus.postMessage(detail);
  localStorage.setItem("missile_sync_event", JSON.stringify(detail));
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
      <p id="authError" class="error"></p>
      <p class="meta">
        ${isSignup ? "Already have an account?" : "New to Missile?"}
        <button id="toggleAuth" type="button" class="auth-toggle">
          ${isSignup ? "Login" : "Sign up"}
        </button>
      </p>
    </div>
  `;

  document.getElementById("toggleAuth").onclick = () => {
    state.mode = isSignup ? "login" : "signup";
    renderAuth();
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
      setSessionUser(email);
      setContacts(email, []);
      renderLock();
      notifySync("auth");
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
  if (!session) {
    renderAuth();
    return;
  }
  askNotificationPermissionFirstTime();
  initNotificationBaseline();

  const user = allUsers().find((u) => u.email === session.email);
  if (!user) {
    logout();
    return;
  }

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
    const lockError = document.getElementById("lockError");

    if (pin !== user.pin) {
      lockError.textContent = "Incorrect PIN.";
      return;
    }

    renderChatApp();
  };
}

function renderContacts() {
  const session = currentUser();
  if (!session) return;
  const contacts = getContacts(session.email);

  if (!contacts.length) {
    el.contactsList.innerHTML = '<p class="empty">No contacts yet.</p>';
    return;
  }

  el.contactsList.innerHTML = contacts
    .map(
      (contact) => `
      <article class="contact-item ${state.activeContactEmail === contact.email ? "active" : ""}" data-email="${contact.email}">
        <h3>${escapeHtml(contact.name)}</h3>
        <p>${escapeHtml(contact.email)}</p>
      </article>
    `
    )
    .join("");

  el.contactsList.querySelectorAll(".contact-item").forEach((item) => {
    item.addEventListener("click", () => {
      state.activeContactEmail = item.dataset.email;
      renderContacts();
      renderMessages();
      renderCallOverlay();
    });
  });
}

function renderMessages() {
  const session = currentUser();
  if (!session) return;

  const activeContact = getActiveContact();

  if (!activeContact) {
    el.activeChatTitle.textContent = "Select a contact";
    el.activeChatSubtitle.textContent = "No chat selected";
    el.messages.innerHTML = '<p class="empty">Choose a contact to start chatting.</p>';
    return;
  }

  el.activeChatTitle.textContent = getDisplayNameForEmail(session.email, activeContact.email);
  el.activeChatSubtitle.textContent = activeContact.email;

  const messages = getMessages(session.email, activeContact.email);

  if (!messages.length) {
    el.messages.innerHTML = '<p class="empty">No messages yet.</p>';
    return;
  }

  el.messages.innerHTML = messages
    .map((message) => {
      const bubbleClass = message.sender === session.email ? "sent" : "received";
      const mediaPart =
        message.type === "media" && message.media
          ? `<div class="media-chip">${escapeHtml(message.media.name)} (${escapeHtml(message.media.mime || "file")})</div>`
          : "";

      return `
        <div class="message ${bubbleClass}">
          <div>${escapeHtml(message.text || "[Media]")}</div>
          ${mediaPart}
          <div class="time">${new Date(message.timestamp).toLocaleString()}</div>
        </div>
      `;
    })
    .join("");

  el.messages.scrollTop = el.messages.scrollHeight;
}

function renderChatApp() {
  const session = currentUser();
  if (!session) {
    renderAuth();
    return;
  }

  el.authScreen.classList.add("hidden");
  el.lockScreen.classList.add("hidden");
  el.chatScreen.classList.remove("hidden");

  const contacts = getContacts(session.email);
  if (!state.activeContactEmail && contacts.length) {
    state.activeContactEmail = contacts[0].email;
  }

  syncKnownConversationsAsContacts();
  renderContacts();
  renderMessages();
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
    alert("You cannot add yourself as a contact.");
    return;
  }

  const contacts = getContacts(session.email);
  if (contacts.some((c) => c.email === email)) {
    alert("Contact already exists.");
    return;
  }

  contacts.push({ name, email });
  setContacts(session.email, contacts);

  if (!state.activeContactEmail) {
    state.activeContactEmail = email;
  }

  nameInput.value = "";
  emailInput.value = "";

  renderContacts();
  renderMessages();
  notifySync("contacts", { owner: session.email });
}

function setMediaPreview(file) {
  const oldPreview = document.getElementById("pendingMediaPreview");
  if (oldPreview) oldPreview.remove();

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
  if (!session || !state.activeContactEmail) return;

  const text = el.messageInput.value.trim();
  const hasMedia = !!state.pendingMedia;
  if (!text && !hasMedia) return;

  const contactEmail = state.activeContactEmail;
  const messages = getMessages(session.email, contactEmail);

  messages.push({
    text: text || "[Media]",
    type: hasMedia ? "media" : "text",
    sender: session.email,
    timestamp: new Date().toISOString(),
    media: hasMedia
      ? {
          name: state.pendingMedia.name,
          mime: state.pendingMedia.type || "unknown",
          size: state.pendingMedia.size
        }
      : null
  });

  setMessages(session.email, contactEmail, messages);
  ensureContact(contactEmail, session.email, allUsers().find((u) => u.email === session.email)?.name || session.email);

  el.messageInput.value = "";
  el.mediaInput.value = "";
  state.pendingMedia = null;
  setMediaPreview(null);

  renderMessages();
  notifySync("message", { conversation: messagesKey(session.email, contactEmail) });
}

function changePin() {
  const session = currentUser();
  if (!session) return;

  const current = prompt("Enter current PIN:");
  if (!current) return;

  const users = allUsers();
  const index = users.findIndex((u) => u.email === session.email);
  if (index === -1) return;

  if (users[index].pin !== current.trim()) {
    alert("Current PIN is incorrect.");
    return;
  }

  const next = prompt("Enter new 4-digit PIN:");
  if (!next || !/^\d{4}$/.test(next.trim())) {
    alert("New PIN must be 4 digits.");
    return;
  }

  users[index].pin = next.trim();
  storage.set("users", users);
  alert("PIN updated successfully.");
}

function logout() {
  endCall(false);
  sessionStorage.removeItem(SESSION_KEY);
  storage.remove("currentUser");
  state.activeContactEmail = null;
  state.pendingMedia = null;
  renderAuth();
  renderCallOverlay();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDuration(totalSeconds) {
  const mins = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const secs = String(totalSeconds % 60).padStart(2, "0");
  return `${mins}:${secs}`;
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
  el.remoteAudio.srcObject = null;
  state.pendingRemoteCandidates = [];
}

function resetCallState() {
  clearCallTimer();
  closePeer();

  state.call.active = false;
  state.call.muted = false;
  state.call.phase = "idle";
  state.call.targetEmail = null;
  state.call.statusText = "Idle";
  state.call.startedAt = null;
  state.call.seconds = 0;
  state.call.pendingOffer = null;
}

function renderCallOverlay() {
  const session = currentUser();
  const activeContact = getActiveContact();

  el.audioCallBtn.disabled = !session || !activeContact || state.call.active;

  if (!state.call.active) {
    el.callOverlay.classList.add("hidden");
    return;
  }

  const targetEmail = state.call.targetEmail || activeContact?.email;
  const displayName = targetEmail && session ? getDisplayNameForEmail(session.email, targetEmail) : "Unknown";

  el.callOverlay.classList.remove("hidden");
  el.callContactName.textContent = displayName;
  el.callStatus.textContent = state.call.statusText;
  el.callTimer.textContent = formatDuration(state.call.seconds);
  el.muteCallBtn.textContent = state.call.muted ? "Unmute" : "Mute";

  const incoming = state.call.phase === "incoming";
  el.acceptCallBtn.classList.toggle("hidden", !incoming);
  el.declineCallBtn.classList.toggle("hidden", !incoming);

  const connected = state.call.phase === "connected";
  el.muteCallBtn.classList.toggle("hidden", incoming);
  el.endCallBtn.classList.toggle("hidden", incoming);
  el.muteCallBtn.disabled = !connected;
}

function publishSignal(targetEmail, type, payload = {}) {
  const session = currentUser();
  if (!session) return;

  const signals = getSignals(session.email, targetEmail);
  signals.push({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`,
    from: session.email,
    to: targetEmail,
    type,
    payload,
    timestamp: Date.now()
  });
  setSignals(session.email, targetEmail, signals);
  notifySync("signal", { pair: signalKey(session.email, targetEmail) });
}

function ensurePeer(targetEmail) {
  if (state.call.peer) return state.call.peer;

  const peer = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  peer.onicecandidate = (event) => {
    if (event.candidate) {
      publishSignal(targetEmail, "candidate", event.candidate);
    }
  };

  peer.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) {
      el.remoteAudio.srcObject = stream;
    }
  };

  peer.onconnectionstatechange = () => {
    if (["disconnected", "failed", "closed"].includes(peer.connectionState)) {
      endCall(false);
      renderCallOverlay();
    }
  };

  state.call.peer = peer;
  return peer;
}

async function ensureLocalAudio() {
  if (state.call.localStream) return state.call.localStream;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.call.localStream = stream;
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

async function startAudioCall() {
  const session = currentUser();
  const activeContact = getActiveContact();
  if (!session || !activeContact || state.call.active) return;

  try {
    state.call.active = true;
    state.call.phase = "outgoing";
    state.call.targetEmail = activeContact.email;
    state.call.statusText = "Calling...";
    renderCallOverlay();

    const stream = await ensureLocalAudio();
    const peer = ensurePeer(activeContact.email);
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    publishSignal(activeContact.email, "offer", offer);
  } catch {
    alert("Unable to start call. Microphone permission is required.");
    resetCallState();
    renderCallOverlay();
  }
}

async function acceptIncomingCall() {
  if (state.call.phase !== "incoming" || !state.call.pendingOffer || !state.call.targetEmail) return;

  try {
    const targetEmail = state.call.targetEmail;
    const stream = await ensureLocalAudio();
    const peer = ensurePeer(targetEmail);
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));

    await peer.setRemoteDescription(new RTCSessionDescription(state.call.pendingOffer));

    for (const c of state.pendingRemoteCandidates) {
      await peer.addIceCandidate(new RTCIceCandidate(c));
    }
    state.pendingRemoteCandidates = [];

    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    publishSignal(targetEmail, "answer", answer);

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

  const targetEmail = state.call.targetEmail;
  if (sendSignal && targetEmail) {
    publishSignal(targetEmail, "end", { duration: state.call.seconds });
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

    state.call.active = true;
    state.call.phase = "incoming";
    state.call.targetEmail = signal.from;
    state.call.pendingOffer = signal.payload;
    state.call.statusText = `Incoming call from ${getDisplayNameForEmail(session.email, signal.from)}`;
    if (document.visibilityState !== "visible") {
      showNotification("Incoming Missile call", `Call from ${getDisplayNameForEmail(session.email, signal.from)}`);
    }

    if (getContacts(session.email).some((c) => c.email === signal.from)) {
      state.activeContactEmail = signal.from;
      renderContacts();
      renderMessages();
    }

    renderCallOverlay();
    return;
  }

  if (!state.call.active || state.call.targetEmail !== signal.from) return;

  const peer = state.call.peer;

  if (signal.type === "answer" && peer) {
    await peer.setRemoteDescription(new RTCSessionDescription(signal.payload));
    for (const c of state.pendingRemoteCandidates) {
      await peer.addIceCandidate(new RTCIceCandidate(c));
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
    alert("Call declined or contact is busy.");
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

  const contacts = getContacts(session.email);
  const knownEmails = new Set(contacts.map((c) => c.email));
  allUsers().forEach((u) => {
    if (u.email !== session.email) knownEmails.add(u.email);
  });

  for (const email of knownEmails) {
    const signals = getSignals(session.email, email);
    for (const signal of signals) {
      await handleSignal(signal);
    }
  }
}

function onExternalSync() {
  if (!currentUser()) return;
  checkIncomingMessageNotifications();
  syncKnownConversationsAsContacts();
  renderContacts();
  renderMessages();
  renderCallOverlay();
  processSignals();
}

function boot() {
  el.contactForm.addEventListener("submit", addContact);
  el.messageForm.addEventListener("submit", sendMessage);
  el.logoutBtn.addEventListener("click", logout);
  el.changePinBtn.addEventListener("click", changePin);
  el.audioCallBtn.addEventListener("click", startAudioCall);
  el.muteCallBtn.addEventListener("click", toggleMuteCall);
  el.endCallBtn.addEventListener("click", () => endCall(true));
  el.acceptCallBtn.addEventListener("click", acceptIncomingCall);
  el.declineCallBtn.addEventListener("click", declineIncomingCall);

  el.mediaInput.addEventListener("change", (event) => {
    const file = event.target.files?.[0] || null;
    state.pendingMedia = file;
    setMediaPreview(file);
  });

  if (bus) {
    bus.onmessage = () => onExternalSync();
  }

  window.addEventListener("storage", (event) => {
    if (!event.key) return;
    if (event.key.startsWith("messages_") || event.key.startsWith("contacts_") || event.key.startsWith("call_signals_") || event.key === "missile_sync_event") {
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

  syncKnownConversationsAsContacts();
  renderCallOverlay();
}

boot();


