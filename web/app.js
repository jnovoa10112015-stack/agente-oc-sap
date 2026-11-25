// Agente OC · Periferia — cliente de chat en JS plano, sin framework, sin build step.
//
// Contrato con el backend: ver web/CONTRATO.md. Resumen:
//   POST /api/chat            { sessionId, message } -> stream SSE (ver eventos abajo)
//   GET  /api/sessions/:id    -> historial para repintar al abrir la página
//
// La clave del proveedor de modelo NUNCA se pide, se lee ni se muestra acá.
// Este archivo no hace ninguna llamada a un proveedor de LLM: solo habla con
// el propio backend, mismo origen.

(() => {
  "use strict";

  const SESSION_STORAGE_KEY = "periferia_oc_session_id";

  const chatLog = document.getElementById("chat-log");
  const composerForm = document.getElementById("composer-form");
  const composerInput = document.getElementById("composer-input");
  const composerFooter = document.querySelector(".composer");
  const btnEnviar = document.getElementById("btn-enviar");
  const btnNueva = document.getElementById("btn-nueva");
  const sessionIndicator = document.getElementById("session-indicator");

  const confirmBanner = document.getElementById("confirm-banner");
  const confirmBannerText = document.getElementById("confirm-banner__text");
  const confirmBannerHallazgos = document.getElementById("confirm-banner__hallazgos");
  const btnConfirmar = document.getElementById("btn-confirmar");
  const btnCancelar = document.getElementById("btn-cancelar");

  /** @type {{ sessionId: string, isWaiting: boolean, awaitingConfirmation: boolean }} */
  const state = {
    sessionId: "",
    isWaiting: false,
    awaitingConfirmation: false,
  };

  // Referencias vivas para ir armando el turno en curso mientras llegan eventos SSE.
  let currentAssistantBubble = null; // <div class="msg assistant"> abierta para streaming de texto
  let thinkingEl = null; // indicador "pensando"
  let ultimaConfirmacionStatus = null;
  const toolCardsById = new Map(); // id de tool_call -> elemento .tool-card

  // ---------------------------------------------------------------------
  // Utilidades de DOM
  // ---------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function scrollToBottom() {
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function clearEmptyState() {
    const empty = chatLog.querySelector(".chat-log__empty");
    if (empty) empty.remove();
  }

  function showEmptyStateIfNeeded() {
    if (chatLog.children.length === 0) {
      const empty = el(
        "div",
        "chat-log__empty",
        'Escribí algo como "procesa la solicitud sol-004" para empezar.'
      );
      chatLog.appendChild(empty);
    }
  }

  // ---------------------------------------------------------------------
  // Markdown de los mensajes del agente (los del usuario van como texto)
  // ---------------------------------------------------------------------

  const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  function escapeHtml(valor) {
    return String(valor).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  }

  // marked (cdnjs, versión fijada en index.html) no sanea su salida, así que
  // el HTML crudo de la entrada se muestra como texto, las imágenes se reducen a
  // su texto alternativo y solo se enlazan URLs http(s) y mailto.
  function crearRenderizadorMarkdown() {
    if (!window.marked || typeof window.marked.Marked !== "function") return null;
    const instancia = new window.marked.Marked({
      gfm: true,
      breaks: true,
      async: false,
      renderer: {
        html({ text }) {
          return escapeHtml(text);
        },
        image({ text }) {
          return escapeHtml(text);
        },
        link({ href, title, tokens }) {
          const contenido = this.parser.parseInline(tokens);
          if (!/^(?:https?:\/\/|mailto:)/i.test(href)) return contenido;
          const atributoTitulo = title ? ` title="${escapeHtml(title)}"` : "";
          return `<a href="${escapeHtml(href)}"${atributoTitulo} target="_blank" rel="noopener noreferrer">${contenido}</a>`;
        },
      },
    });
    return (texto) => instancia.parse(texto);
  }

  // Si marked no cargó (sin red o bloqueado), el chat sigue funcionando y
  // los mensajes del agente se muestran como texto plano.
  const renderizarMarkdown = crearRenderizadorMarkdown();
  const textoCrudoPorBurbuja = new WeakMap();

  function establecerTextoAsistente(bubble, texto) {
    textoCrudoPorBurbuja.set(bubble, texto);
    if (renderizarMarkdown) {
      try {
        bubble.innerHTML = renderizarMarkdown(texto);
        bubble.classList.add("md");
        return;
      } catch (error) {
        console.error("No se pudo renderizar el markdown del mensaje:", error);
      }
    }
    bubble.classList.remove("md");
    bubble.textContent = texto;
  }

  function agregarTextoAsistente(bubble, fragmento) {
    establecerTextoAsistente(bubble, (textoCrudoPorBurbuja.get(bubble) || "") + fragmento);
  }

  function safeJsonStringify(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  // ---------------------------------------------------------------------
  // Sesión: crear/recuperar sessionId y cargar historial previo
  // ---------------------------------------------------------------------

  function generarSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "sess-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function iniciarSesionNueva() {
    state.sessionId = generarSessionId();
    localStorage.setItem(SESSION_STORAGE_KEY, state.sessionId);
    chatLog.innerHTML = "";
    toolCardsById.clear();
    ultimaConfirmacionStatus = null;
    currentAssistantBubble = null;
    setAwaitingConfirmation(false, "", null);
    actualizarIndicadorSesion();
    showEmptyStateIfNeeded();
  }

  function actualizarIndicadorSesion() {
    sessionIndicator.textContent = "sesión: " + state.sessionId.slice(0, 8);
    sessionIndicator.title = state.sessionId;
  }

  async function cargarHistorial(sessionId) {
    let res;
    try {
      res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    } catch {
      // Backend no disponible todavía o red caída: arrancamos con sesión vacía,
      // no es un error fatal para el usuario.
      return false;
    }

    if (res.status === 404) {
      return false;
    }
    if (!res.ok) {
      return false;
    }

    let body;
    try {
      body = await res.json();
    } catch {
      return false;
    }

    if (!body || body.ok !== true || !Array.isArray(body.mensajes)) {
      return false;
    }

    for (const item of body.mensajes) {
      renderHistoryItem(item);
    }
    const ultimo = body.mensajes[body.mensajes.length - 1];
    if (ultimo && ultimo.type === "needs_confirmation") {
      setAwaitingConfirmation(true, ultimo.pregunta, ultimo.hallazgos);
    }
    return true;
  }

  /**
   * Repinta un item ya ocurrido (GET /api/sessions/:id). Usa los mismos
   * renderizadores que el streaming en vivo, pero sin animaciones de
   * "escribiendo" ni indicador de pensando.
   */
  function renderHistoryItem(item) {
    if (!item || typeof item.type !== "string") return;
    clearEmptyState();

    switch (item.type) {
      case "user_message":
        resolverTarjetaConfirmacion(item.text || "");
        appendUserMessage(item.text || "");
        break;
      case "message":
        closeAssistantBubble();
        currentAssistantBubble = crearBurbujaAssistant();
        establecerTextoAsistente(currentAssistantBubble, item.text || "");
        closeAssistantBubble();
        break;
      case "tool_call":
        closeAssistantBubble();
        crearToolCard(item.id, item.name, item.args);
        break;
      case "tool_result":
        actualizarToolCard(item.id, item);
        break;
      case "needs_confirmation":
        closeAssistantBubble();
        renderNeedsConfirmationCard(item);
        // Si es el último item del historial, dejamos el estado activo.
        break;
      case "error":
        closeAssistantBubble();
        appendSystemError(item.message || "Error desconocido.");
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------
  // Mensajes de usuario / asistente / sistema
  // ---------------------------------------------------------------------

  function appendUserMessage(text) {
    clearEmptyState();
    closeAssistantBubble();
    const bubble = el("div", "msg user", text);
    chatLog.appendChild(bubble);
    scrollToBottom();
  }

  function crearBurbujaAssistant() {
    clearEmptyState();
    const bubble = el("div", "msg assistant streaming", "");
    chatLog.appendChild(bubble);
    scrollToBottom();
    return bubble;
  }

  function closeAssistantBubble() {
    if (currentAssistantBubble) {
      currentAssistantBubble.classList.remove("streaming");
      currentAssistantBubble = null;
    }
  }

  function appendSystemError(text) {
    clearEmptyState();
    closeAssistantBubble();
    const bubble = el("div", "msg system error", text);
    chatLog.appendChild(bubble);
    scrollToBottom();
  }

  function appendSystemNote(text) {
    clearEmptyState();
    closeAssistantBubble();
    const bubble = el("div", "msg system", text);
    chatLog.appendChild(bubble);
    scrollToBottom();
  }

  function mostrarPensando() {
    if (thinkingEl) return;
    clearEmptyState();
    thinkingEl = el("div", "thinking");
    thinkingEl.appendChild(el("span"));
    thinkingEl.appendChild(el("span"));
    thinkingEl.appendChild(el("span"));
    chatLog.appendChild(thinkingEl);
    scrollToBottom();
  }

  function ocultarPensando() {
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  }

  // ---------------------------------------------------------------------
  // Tarjetas de llamada a herramienta — nunca texto plano indistinguible
  // ---------------------------------------------------------------------

  // Cabecera de la tarjeta: siempre visible (nombre + estado en una línea);
  // al hacer clic, o con Enter/Espacio, se despliega el cuerpo.
  function hacerPlegable(head, card) {
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    const sincronizar = () => head.setAttribute("aria-expanded", String(card.classList.contains("is-open")));
    const alternar = () => {
      card.classList.toggle("is-open");
      sincronizar();
    };
    head.addEventListener("click", alternar);
    head.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        alternar();
      }
    });
    sincronizar();
  }

  function crearToolCard(id, name, args) {
    clearEmptyState();
    const card = el("div", "tool-card pending");
    card.dataset.toolId = id || "";

    const head = el("div", "tool-card__head");
    head.appendChild(el("span", "tool-card__icon", "🔧"));
    head.appendChild(el("span", "tool-card__name", name || "herramienta"));
    const status = el("span", "tool-card__status", "ejecutando…");
    head.appendChild(status);
    head.appendChild(el("span", "tool-card__chevron", "▶"));
    hacerPlegable(head, card);

    const body = el("div", "tool-card__body");
    body.appendChild(el("div", "tool-card__section-label", "Entrada"));
    const argsPre = el("pre", "tool-card__pre", safeJsonStringify(args ?? {}));
    body.appendChild(argsPre);

    const resultLabel = el("div", "tool-card__section-label", "Resultado");
    resultLabel.classList.add("tool-card__result-label");
    resultLabel.hidden = true;
    body.appendChild(resultLabel);

    const resultSlot = el("div", "tool-card__result-slot");
    body.appendChild(resultSlot);

    card.appendChild(head);
    card.appendChild(body);
    chatLog.appendChild(card);

    if (id) toolCardsById.set(id, card);
    scrollToBottom();
    return card;
  }

  /**
   * Clasifica el resultado de una herramienta según los tres niveles del
   * PRD §7.3: bloqueo (rojo), confirmación (ámbar), derivado (gris).
   * Es una clasificación puramente visual sobre datos que ya vienen resueltos
   * por las reglas RC1-RC10 en el backend; el front no evalúa ningún control.
   */
  function clasificarResultado(payload) {
    if (!payload || payload.ok !== true) {
      return { nivel: "error", chips: [] };
    }
    const data = payload.data;
    const chips = [];
    let nivel = "ok";

    const bloqueos = data && Array.isArray(data.bloqueos) ? data.bloqueos : [];
    const confirmaciones = data && Array.isArray(data.confirmaciones) ? data.confirmaciones : [];
    const derivados = data && typeof data.derivados === "object" && data.derivados !== null
      ? data.derivados
      : null;

    if (bloqueos.length > 0) {
      nivel = "bloqueo";
      for (const h of bloqueos) {
        chips.push({ tipo: "bloqueo", texto: formatHallazgo(h) });
      }
    } else if (confirmaciones.length > 0) {
      nivel = "confirmacion";
    }

    for (const h of confirmaciones) {
      chips.push({ tipo: "confirmacion", texto: formatHallazgo(h) });
    }

    if (derivados) {
      for (const [campo, valor] of Object.entries(derivados)) {
        if (valor !== null && valor !== undefined) {
          chips.push({ tipo: "derivado", texto: `${campo}: ${valor}` });
        }
      }
    }

    if (data && data.retroactiva === true) {
      chips.push({ tipo: "confirmacion", texto: "retroactiva" });
      if (nivel === "ok") nivel = "confirmacion";
    }

    return { nivel, chips };
  }

  function formatHallazgo(h) {
    if (!h || typeof h !== "object") return String(h);
    const codigo = h.codigo ? `${h.codigo}: ` : "";
    return `${codigo}${h.detalle || ""}`;
  }

  function actualizarToolCard(id, resultado) {
    const card = id ? toolCardsById.get(id) : null;
    if (!card) {
      // Resultado sin tarjeta previa (no debería pasar si el backend respeta
      // el contrato, pero no rompemos el chat por esto).
      appendSystemNote(
        `Resultado de herramienta recibido sin llamada previa (id: ${id || "desconocido"}).`
      );
      return;
    }

    card.classList.remove("pending");
    const status = card.querySelector(".tool-card__status");
    const resultLabel = card.querySelector(".tool-card__result-label");
    const resultSlot = card.querySelector(".tool-card__result-slot");
    resultLabel.hidden = false;

    if (resultado.ok !== true) {
      card.classList.add("error");
      if (status) status.textContent = "ERROR";
      const errorNode = el("p", "tool-card__error", resultado.error || "Error sin detalle.");
      resultSlot.appendChild(errorNode);
      if (resultado.codigo) {
        resultSlot.appendChild(el("pre", "tool-card__pre", `código: ${resultado.codigo}`));
      }
      scrollToBottom();
      return;
    }

    const { nivel, chips } = clasificarResultado(resultado);
    card.classList.add(nivel);
    if (status) {
      // La herramienta respondió sin error: el estado es OK. Si el resultado
      // trae un bloqueo o una confirmación pendiente, se indica al lado y el
      // color de la tarjeta sigue la severidad.
      const matices = { bloqueo: " · bloqueo", confirmacion: " · confirmación" };
      status.textContent = "OK" + (matices[nivel] || "");
    }

    const pre = el("pre", "tool-card__pre", safeJsonStringify(resultado.data ?? {}));
    resultSlot.appendChild(pre);

    if (chips.length > 0) {
      const chipsWrap = el("div", "tool-card__chips");
      for (const c of chips) {
        chipsWrap.appendChild(el("span", `chip chip--${c.tipo}`, c.texto));
      }
      resultSlot.appendChild(chipsWrap);
    }

    scrollToBottom();
  }

  // ---------------------------------------------------------------------
  // Estado "esperando confirmación" (CA3 del PRD) — visualmente distintivo
  // ---------------------------------------------------------------------

  function renderNeedsConfirmationCard(payload) {
    // Deja también un registro fijo en el historial del chat, además del
    // banner flotante junto al composer.
    const card = el("div", "tool-card confirmacion is-open");
    const head = el("div", "tool-card__head");
    head.appendChild(el("span", "tool-card__icon", "⏸"));
    head.appendChild(el("span", "tool-card__name", "confirmación requerida"));
    ultimaConfirmacionStatus = el("span", "tool-card__status", "pendiente");
    head.appendChild(ultimaConfirmacionStatus);
    head.appendChild(el("span", "tool-card__chevron", "▶"));
    hacerPlegable(head, card);

    const body = el("div", "tool-card__body");
    body.appendChild(el("p", null, payload.pregunta || "El agente necesita tu confirmación."));

    const chipsWrap = el("div", "tool-card__chips");
    const hallazgos = payload.hallazgos || {};
    const confirmaciones = Array.isArray(hallazgos.confirmaciones) ? hallazgos.confirmaciones : [];
    for (const h of confirmaciones) {
      chipsWrap.appendChild(el("span", "chip chip--confirmacion", formatHallazgo(h)));
    }
    if (hallazgos.derivados && typeof hallazgos.derivados === "object") {
      for (const [campo, valor] of Object.entries(hallazgos.derivados)) {
        if (valor !== null && valor !== undefined) {
          chipsWrap.appendChild(el("span", "chip chip--derivado", `${campo}: ${valor}`));
        }
      }
    }
    if (hallazgos.retroactiva === true) {
      chipsWrap.appendChild(el("span", "chip chip--confirmacion", "retroactiva"));
    }
    if (chipsWrap.children.length > 0) body.appendChild(chipsWrap);

    card.appendChild(head);
    card.appendChild(body);
    chatLog.appendChild(card);
    scrollToBottom();
  }

  function resolverTarjetaConfirmacion(respuesta) {
    if (!ultimaConfirmacionStatus) return;
    const decision = respuesta.trim().toLowerCase();
    ultimaConfirmacionStatus.textContent = decision === "confirmo" ? "confirmada" : decision === "cancelo" ? "cancelada" : "abandonada";
    ultimaConfirmacionStatus = null;
  }

  function setAwaitingConfirmation(activo, pregunta, hallazgos) {
    state.awaitingConfirmation = !!activo;
    confirmBanner.hidden = !activo;
    composerFooter.classList.toggle("is-awaiting-confirmation", !!activo);

    if (!activo) {
      confirmBannerText.textContent = "";
      confirmBannerHallazgos.innerHTML = "";
      return;
    }

    confirmBannerText.textContent = pregunta || "El agente necesita tu confirmación para continuar.";
    confirmBannerHallazgos.innerHTML = "";
    const confirmaciones =
      hallazgos && Array.isArray(hallazgos.confirmaciones) ? hallazgos.confirmaciones : [];
    for (const h of confirmaciones) {
      confirmBannerHallazgos.appendChild(el("span", "chip chip--confirmacion", formatHallazgo(h)));
    }
    if (hallazgos && hallazgos.retroactiva === true) {
      confirmBannerHallazgos.appendChild(el("span", "chip chip--confirmacion", "retroactiva"));
    }
  }

  // ---------------------------------------------------------------------
  // Envío de mensajes y consumo del stream SSE de POST /api/chat
  // ---------------------------------------------------------------------

  function setEnviando(enviando) {
    state.isWaiting = enviando;
    composerInput.disabled = enviando;
    btnEnviar.disabled = enviando;
    btnConfirmar.disabled = enviando;
    btnCancelar.disabled = enviando;
  }

  async function enviarMensaje(texto) {
    if (!texto.trim() || state.isWaiting) return;

    resolverTarjetaConfirmacion(texto);
    appendUserMessage(texto);
    // El turno arranca: cualquier confirmación pendiente visual queda resuelta
    // por la respuesta del usuario; el backend decide si de verdad procede.
    setAwaitingConfirmation(false, "", null);
    setEnviando(true);
    mostrarPensando();
    currentAssistantBubble = null;

    let res;
    try {
      res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ sessionId: state.sessionId, message: texto }),
      });
    } catch {
      ocultarPensando();
      appendSystemError("No se pudo contactar al backend. Revisá tu conexión e intentá de nuevo.");
      setEnviando(false);
      return;
    }

    if (!res.ok || !res.body) {
      ocultarPensando();
      let detalle = `Error HTTP ${res.status}.`;
      try {
        const body = await res.json();
        if (body && body.error) detalle = body.error;
      } catch {
        // sin cuerpo JSON legible; nos quedamos con el detalle genérico
      }
      appendSystemError(detalle);
      setEnviando(false);
      return;
    }

    try {
      await consumirStream(res.body);
    } finally {
      ocultarPensando();
      closeAssistantBubble();
      setEnviando(false);
    }
  }

  async function consumirStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let recibioDone = false;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseFrame(frame);
          if (parsed && parsed.event === "done") recibioDone = true;
          if (parsed) manejarEventoSSE(parsed.event, parsed.data);
        }
      }
    } catch {
      appendSystemError("Se interrumpió la conexión con el agente. Podés volver a escribir.");
      return;
    }

    if (!recibioDone) {
      // El stream se cerró sin un evento `done` explícito: lo tratamos como
      // fin de turno igual, para no dejar el chat trabado, pero avisamos.
      appendSystemNote("La conexión con el agente se cerró antes de tiempo.");
    }
  }

  function parseSseFrame(frame) {
    let eventName = "message";
    const dataLines = [];
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    const raw = dataLines.join("\n");
    if (!raw) return { event: eventName, data: null };
    try {
      return { event: eventName, data: JSON.parse(raw) };
    } catch {
      return { event: eventName, data: raw };
    }
  }

  function manejarEventoSSE(eventName, data) {
    switch (eventName) {
      case "message":
        ocultarPensando();
        if (!currentAssistantBubble) currentAssistantBubble = crearBurbujaAssistant();
        agregarTextoAsistente(currentAssistantBubble, (data && data.text) || "");
        scrollToBottom();
        if (data && data.final) closeAssistantBubble();
        break;

      case "tool_call":
        ocultarPensando();
        closeAssistantBubble();
        if (data) crearToolCard(data.id, data.name, data.args);
        break;

      case "tool_result":
        if (data) actualizarToolCard(data.id, data);
        break;

      case "needs_confirmation":
        ocultarPensando();
        closeAssistantBubble();
        if (data) {
          renderNeedsConfirmationCard(data);
          setAwaitingConfirmation(true, data.pregunta, data.hallazgos);
        }
        break;

      case "error":
        ocultarPensando();
        closeAssistantBubble();
        appendSystemError((data && data.message) || "Ocurrió un error en el agente.");
        break;

      case "done":
        ocultarPensando();
        closeAssistantBubble();
        // Si el backend indica needsConfirmation=true pero por algún motivo
        // no llegó el evento needs_confirmation, igual dejamos el input
        // normal habilitado: la fuente de verdad del contenido es ese evento.
        break;

      default:
        // Evento desconocido: lo ignoramos sin romper el turno (CA5).
        break;
    }
  }

  // ---------------------------------------------------------------------
  // Wiring de la interfaz
  // ---------------------------------------------------------------------

  composerForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const texto = composerInput.value;
    composerInput.value = "";
    autoResizeTextarea();
    enviarMensaje(texto);
  });

  composerInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      composerForm.requestSubmit();
    }
  });

  composerInput.addEventListener("input", autoResizeTextarea);

  function autoResizeTextarea() {
    composerInput.style.height = "auto";
    composerInput.style.height = Math.min(composerInput.scrollHeight, 140) + "px";
  }

  btnConfirmar.addEventListener("click", () => {
    enviarMensaje("confirmo");
  });

  btnCancelar.addEventListener("click", () => {
    enviarMensaje("cancelo");
  });

  btnNueva.addEventListener("click", () => {
    if (state.isWaiting) return;
    iniciarSesionNueva();
  });

  // ---------------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------------

  async function init() {
    const existente = localStorage.getItem(SESSION_STORAGE_KEY);
    state.sessionId = existente || generarSessionId();
    if (!existente) localStorage.setItem(SESSION_STORAGE_KEY, state.sessionId);
    actualizarIndicadorSesion();

    if (existente) {
      const cargado = await cargarHistorial(existente);
      if (!cargado) {
        // Sesión vieja que el backend ya no conoce (por ejemplo, se reinició
        // el servidor, que guarda sesiones en memoria): empezamos de cero.
        iniciarSesionNueva();
      }
    }

    showEmptyStateIfNeeded();
  }

  init();
})();
