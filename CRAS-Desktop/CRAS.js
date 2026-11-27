        (async () => {
            const bootScreen = document.getElementById("boot-screen");
            const bootStartedAt = performance.now();
            const bootLogo = bootScreen.querySelector(".boot-logo");
            const bootCaption = bootScreen.querySelector(".boot-caption");
            const seasonalDate = new Date();
            const seasonalMonth = seasonalDate.getMonth() + 1;
            const seasonalDay = seasonalDate.getDate();
            const seasonalMode = (seasonalMonth === 12 && seasonalDay >= 25)
                || (seasonalMonth === 1 && seasonalDay <= 1)
                ? "new-year"
                : seasonalMonth === 12 && seasonalDay >= 10 && seasonalDay < 25
                    ? "christmas"
                    : null;
            let seasonalTimer = null;
            let resolveSeasonalSequence = () => {};
            let skipSeasonalSequence = false;
            let bootFailsafe;

            if (seasonalMode === "christmas") {
                bootLogo.classList.add("is-christmas");
                bootLogo.setAttribute("aria-label", "HO HO HO");
                bootLogo.replaceChildren();
                let letterIndex = 0;
                for (const character of "HO HO HO") {
                    if (character === " ") {
                        bootLogo.append(document.createTextNode(" "));
                        continue;
                    }
                    const letter = document.createElement("span");
                    letter.textContent = character;
                    letter.style.setProperty("--letter-index", String(letterIndex));
                    if (letterIndex > 0 && letterIndex % 2 === 0) letter.style.marginLeft = ".3em";
                    letterIndex += 1;
                    bootLogo.append(letter);
                }
            } else if (seasonalMode === "new-year") {
                const newYearColors = [
                    { name: "Branco", value: "#f4f1e8", meaning: "Paz, harmonia e novos começos." },
                    { name: "Dourado", value: "#c58b18", meaning: "Prosperidade, abundância e realizações." },
                    { name: "Verde", value: "#24805a", meaning: "Esperança, saúde e equilíbrio." },
                    { name: "Azul", value: "#3478b8", meaning: "Serenidade, confiança e tranquilidade." },
                    { name: "Violeta", value: "#7651a5", meaning: "Espiritualidade, autoconhecimento e transformação." }
                ];
                const skipHint = document.createElement("p");
                skipHint.className = "boot-seasonal-hint";
                skipHint.textContent = "Pressione Enter para continuar";
                bootCaption.after(skipHint);
                bootCaption.setAttribute("role", "status");
                bootCaption.setAttribute("aria-live", "polite");
                bootScreen.classList.add("is-new-year");
                let colorIndex = 0;
                const showNewYearColor = () => {
                    const color = newYearColors[colorIndex];
                    bootLogo.classList.add("is-new-year");
                    bootLogo.style.setProperty("--seasonal-color", color.value);
                    bootLogo.textContent = color.name;
                    bootLogo.setAttribute("aria-label", color.name);
                    bootCaption.textContent = color.meaning;
                };
                showNewYearColor();
                seasonalTimer = window.setInterval(() => {
                    if (colorIndex === newYearColors.length - 1) {
                        window.clearInterval(seasonalTimer);
                        seasonalTimer = null;
                        resolveSeasonalSequence();
                        return;
                    }
                    colorIndex += 1;
                    showNewYearColor();
                }, 2200);
            }

            let bootDismissed = false;
            const dismissBootScreen = () => {
                if (bootDismissed) return;
                bootDismissed = true;
                if (seasonalTimer !== null) {
                    window.clearInterval(seasonalTimer);
                    seasonalTimer = null;
                }
                resolveSeasonalSequence();
                window.removeEventListener("keydown", skipSeasonalOnEnter, true);
                bootScreen.classList.add("is-leaving");
                window.setTimeout(() => { bootScreen.hidden = true; }, 200);
            };
            const seasonalSequence = seasonalMode === "new-year"
                ? new Promise(resolve => { resolveSeasonalSequence = resolve; })
                : Promise.resolve();
            const skipSeasonalOnEnter = event => {
                if (event.key !== "Enter" || seasonalMode !== "new-year" || bootScreen.hidden) return;
                event.preventDefault();
                skipSeasonalSequence = true;
                dismissBootScreen();
            };
            if (seasonalMode === "new-year") {
                window.addEventListener("keydown", skipSeasonalOnEnter, true);
            }
            bootFailsafe = window.setTimeout(dismissBootScreen, seasonalMode === "new-year" ? 15000 : 2000);
            const completeBootScreen = async () => {
                window.clearTimeout(bootFailsafe);
                const minimumDisplayMs = 450;
                await new Promise(resolve => window.setTimeout(
                    resolve,
                    Math.max(0, minimumDisplayMs - (performance.now() - bootStartedAt))
                ));
                if (seasonalMode === "new-year" && !skipSeasonalSequence) {
                    if (document.body.classList.contains("reduce-motion")
                        || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
                        skipSeasonalSequence = true;
                        dismissBootScreen();
                    } else {
                        await seasonalSequence;
                    }
                }

                async function saveAppointmentAndPeople(records, nextPeople) {
                    try {
                        const actorRole = activeUser?.role;
                        stampSyncAuthority(STORAGE_RECORDS, records, actorRole);
                        const persistedRecords = await protectTechnicalAnnotations(records);
                        const { recordsToWrite, idsToDelete } = getAppointmentWriteChanges(persistedRecords);
                        await database.transaction("rw", database.appointments, database.settings, async () => {
                            if (idsToDelete.length) await database.appointments.bulkDelete(idsToDelete);
                            if (recordsToWrite.length) await database.appointments.bulkPut(recordsToWrite);
                            await database.settings.put({ key: STORAGE_PEOPLE, value: nextPeople });
                        });
                        storageCache.set(STORAGE_RECORDS, records);
                        storageCache.set(STORAGE_PEOPLE, nextPeople);
                        scheduleLocalSnapshotPersist(actorRole);
                        schedulePeerSync(actorRole);
                        syncPendingChanges = true;
                        updateSyncIndicator();
                        return true;
                    } catch (error) {
                        console.error("Falha ao salvar atendimento e cadastro da pessoa.", error);
                        showToast("Não foi possível salvar o atendimento e o cadastro da pessoa neste dispositivo.");
                        return false;
                    }
                }
                dismissBootScreen();
            };
            if (!window.Dexie) {
                dismissBootScreen();
                window.alert("Dexie.js não foi encontrado. Mantenha o arquivo dexie.min.js na mesma pasta deste HTML.");
                return;
            }
            const STORAGE_RECORDS = "cras-ouro-preto-atendimentos-v1";
            const STORAGE_ROUTES = "cras-ouro-preto-encaminhamentos-v1";
            const STORAGE_PREFERENCES = "cras-ouro-preto-preferencias-v1";
            const STORAGE_ASSISTANTS = "cras-ouro-preto-assistentes-v1";
            const STORAGE_USERS = "cras-ouro-preto-usuarios-v1";
            const STORAGE_NATIONALITIES = "cras-ouro-preto-nacionalidades-v1";
            const STORAGE_ROUTE_QUEUE_TAGS = "cras-ouro-preto-encaminhamento-filas-v1";
            const STORAGE_PAA_RECORDS = "cras-ouro-preto-paa-registros-v1";
            const STORAGE_PEOPLE = "cras-ouro-preto-pessoas-v1";
            const STORAGE_TECHNICAL_E2EE = "cras-ouro-preto-technical-e2ee-v1";
            const STORAGE_SYNC_BASE = "cras-ouro-preto-sync-base-v1";
            const STORAGE_PEER_SYNC_BASES = "cras-ouro-preto-peer-sync-bases-v1";
            const STORAGE_LOCAL_NODE_REVISION = "cras-ouro-preto-local-node-revision-v1";
            const STORAGE_LOCAL_NODE_BASE_SNAPSHOT = "cras-ouro-preto-local-node-base-snapshot-v1";
            const STORAGE_LAST_SUCCESSFUL_SYNC = "cras-ouro-preto-ultima-sincronizacao-v1";
            const STORAGE_LOCAL_ACTIVE_USER = "cras-ouro-preto-usuario-local-v1";
            const STORAGE_REMEMBER_USER_SESSION = "cras-ouro-preto-lembrar-sessao-v1";
            const STORAGE_APPOINTMENT_DRAFT_PREFIX = "cras-ouro-preto-rascunho-atendimento-v1:";
            const STORAGE_HISTORY_FILTER_PRESETS = "cras-ouro-preto-filtros-historico-v1";
            const STORAGE_DASHBOARD_LAYOUT_PREFIX = "cras-ouro-preto-dashboard-layout-v1:";
            const STORAGE_MOBILE_ACCESS_INFO = "cras-mobile-access-info-v1";
            const STORAGE_MOBILE_ACCESS_PROOF = "cras-mobile-access-proof-v1";
            const STORAGE_MOBILE_ACCESS_KEY = "cras-mobile-access-key-v1";
            const STORAGE_MOBILE_NODE_REVISION = "cras-mobile-node-revision-v1";
            const STORAGE_MOBILE_NODE_BASE_SNAPSHOT = "cras-mobile-node-base-snapshot-v1";
            const STORAGE_PENDING_CHAT_MESSAGES = "cras-pending-central-chat-messages-v1";
            const SYSTEM_ADMIN_USER_ID = "cras-system-admin-adm-dev";
            const SYSTEM_ADMIN_NAME = "adm.dev";
            const STORAGE_DAIANE_ADMIN_MIGRATION = "cras-daiane-admin-default-migrated-v1";
            const LEGACY_STORAGE_ETHNICITIES = "cras-ouro-preto-etnias-v1";
            const STORAGE_MIGRATION_MARKER = "legacy-local-storage-migrated-v1";
            const STORAGE_SETTINGS_KEYS = [
                STORAGE_ROUTES,
                STORAGE_PREFERENCES,
                STORAGE_ASSISTANTS,
                STORAGE_USERS,
                STORAGE_NATIONALITIES,
                STORAGE_ROUTE_QUEUE_TAGS,
                STORAGE_PAA_RECORDS,
                STORAGE_PEOPLE,
                STORAGE_TECHNICAL_E2EE,
                STORAGE_SYNC_BASE,
                STORAGE_PEER_SYNC_BASES,
                STORAGE_LOCAL_NODE_REVISION,
                STORAGE_LOCAL_NODE_BASE_SNAPSHOT,
                STORAGE_LAST_SUCCESSFUL_SYNC,
                LEGACY_STORAGE_ETHNICITIES
            ];
            const SYNC_SETTING_KEYS = [
                STORAGE_ROUTES,
                STORAGE_PREFERENCES,
                STORAGE_ASSISTANTS,
                STORAGE_USERS,
                STORAGE_NATIONALITIES,
                STORAGE_ROUTE_QUEUE_TAGS,
                STORAGE_TECHNICAL_E2EE
            ];
            const QUEUE_TAGS = { cadastro: "cadastro unico", assistencia: "assistencia" };
            const QUEUE_TAG_NONE = "nenhum";
            const QUEUE_PROMPT_DELAY = { cadastro: 25 * 60 * 1000, assistencia: 15 * 60 * 1000 };
            const ASSISTANCE_DURATION = 10 * 60 * 1000;
            const FORM_IDLE_DELAY = 2 * 60 * 1000;
            const DEFAULT_ROUTE_QUEUE_TAGS = {
                "Atendimento Técnico": [QUEUE_TAGS.assistencia],
                "Assistência": [QUEUE_TAGS.assistencia],
                "Cadastro Único": [QUEUE_TAGS.cadastro],
                Informação: [QUEUE_TAG_NONE]
            };
            const DEFAULT_ASSISTANTS = [
                { name: "Anthea", color: "#4b8061" },
                { name: "Neli", color: "#bd8950" },
                { name: "Patricia", color: "#527c9b" },
                { name: "Daiane", color: "#9a6e8e" }
            ];
            const DEFAULT_ROUTES = ["Cadastro Único", "Atendimento Técnico", "Informação"];
            const DEFAULT_NATIONALITIES = ["Venezuelano", "Uruguaio", "Argentino"];
            const DASHBOARD_LAYOUT_VERSION = 1;
            const DASHBOARD_WIDGETS = [
                { id: "quick-actions", label: "Ações rápidas" },
                { id: "date", label: "Data do painel" },
                { id: "attendance-total", label: "Atendimentos de hoje" },
                { id: "queue-summary", label: "Resumo das filas" },
                { id: "team-stats", label: "Atendimentos por técnico" },
                { id: "cadastro-queue", label: "Fila do Cadastro Único" },
                { id: "assistance-queue", label: "Fila do Atendimento Técnico" }
            ];
            const DEFAULT_PREFERENCES = { darkMode: false, highContrast: false, reduceMotion: false, colorTheme: "green", fontScale: "1", showHints: true, showSyncMessages: true, autoCompleteHistory: false, paaEnabled: true, isPrincipalComputer: false, syncEndpoint: "", syncToken: "", syncPeers: [], googleSheetEndpoint: "" };
            const BACKUP_FORMAT = "cras-ouro-preto-backup";
            const BACKUP_VERSION = 1;
            const HISTORY_PAGE_SIZE = 50;
            const CHAT_PAGE_SIZE = 50;
            const CHAT_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
            const MAX_BACKUP_FILE_BYTES = 100 * 1024 * 1024;
            const CHAT_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
            const form = document.getElementById("appointment-form");
            const assistantChoiceList = document.getElementById("assistant-choice-list");
            const caseworkerAssignment = document.getElementById("caseworker-assignment");
            const caseworkerAssignmentWrap = document.getElementById("caseworker-assignment-wrap");
            const formTitle = document.getElementById("form-title");
            const submitButton = form.querySelector('button[type="submit"]');
            const nameInput = document.getElementById("nome");
            const cpfInput = document.getElementById("cpf");
            const phoneInput = document.getElementById("telefone");
            const addressInput = document.getElementById("endereco");
            const numberInput = document.getElementById("numero");
            const appointmentDateInput = document.getElementById("appointment-date");
            const routeValue = document.getElementById("route-value");
            const routeOptions = document.getElementById("route-options");
            const routeCarousel = document.getElementById("route-carousel");
            const routeTrigger = document.getElementById("route-trigger");
            const routeSearchInput = document.getElementById("route-search");
            const routeSearchEmpty = document.getElementById("route-search-empty");
            const routeCurrent = document.getElementById("route-current");
            const nationalityValue = document.getElementById("nationality-value");
            const nationalityOptions = document.getElementById("nationality-options");
            const nationalityCarousel = document.getElementById("nationality-carousel");
            const nationalityTrigger = document.getElementById("nationality-trigger");
            const nationalitySearchInput = document.getElementById("nationality-search");
            const nationalitySearchEmpty = document.getElementById("nationality-search-empty");
            const nationalityCurrent = document.getElementById("nationality-current");
            const formStatus = document.getElementById("form-status");
            const historyBody = document.getElementById("history-body");
            const emptyState = document.getElementById("empty-state");
            const staffHistoryPanel = document.getElementById("staff-history-panel");
            const staffHistorySearch = document.getElementById("staff-history-search");
            const staffHistoryList = document.getElementById("staff-history-list");
            const staffHistoryCount = document.getElementById("staff-history-count");
            const staffHistoryEmpty = document.getElementById("staff-history-empty");
            const staffHistoryPagination = document.getElementById("staff-history-pagination");
            let historyPage = 0;
            let staffHistoryPage = 0;
            const chatMessagesElement = document.getElementById("chat-messages");
            let chatMessages = [];
            let chatPerson = null;
            let chatAttachment = null;
            let chatRecipientId = "";
            let centralServerDiscoveryCache = null;
            let centralServerDiscoveryTime = 0;
            let loginServerPasswordMode = false;
            let chatLoadInProgress = false;
            let chatReloadRequested = false;
            let chatPollTimer = null;
            let chatLoadErrorShown = false;
            const toast = document.getElementById("toast");
            const deleteConfirmOverlay = document.getElementById("delete-confirm-overlay");
            const deleteConfirmTitle = document.getElementById("delete-confirm-title");
            const deleteConfirmMessage = document.getElementById("delete-confirm-message");
            const deleteConfirmCancel = document.getElementById("delete-confirm-cancel");
            const deleteConfirmSubmit = document.getElementById("delete-confirm-submit");
            const appointmentAnnotationsOverlay = document.getElementById("appointment-annotations-overlay");
            const appointmentAnnotationsForm = document.getElementById("appointment-annotations-form");
            const appointmentAnnotationsTitle = document.getElementById("appointment-annotations-title");
            const appointmentAnnotationsRecord = document.getElementById("appointment-annotations-record");
            const appointmentAnnotationsCategories = document.getElementById("appointment-annotations-categories");
            const appointmentAnnotationsStatus = document.getElementById("appointment-annotations-status");
            const appointmentAnnotationsCancel = document.getElementById("appointment-annotations-cancel");
            const appointmentAnnotationsSave = document.getElementById("appointment-annotations-save");
            const autocompleteOverlay = document.getElementById("history-autocomplete-overlay");
            const autocompleteTitle = document.getElementById("history-autocomplete-title");
            const autocompleteMessage = document.getElementById("history-autocomplete-message");
            const autocompleteList = document.getElementById("history-autocomplete-list");
            const autocompleteCancel = document.getElementById("history-autocomplete-cancel");
            const autocompleteSubmit = document.getElementById("history-autocomplete-submit");
            const paaForm = document.getElementById("paa-form");
            const paaNameInput = document.getElementById("paa-name");
            const paaCpfInput = document.getElementById("paa-cpf");
            const paaPhoneInput = document.getElementById("paa-phone");
            const paaMonthInput = document.getElementById("paa-month");
            const paaFormStatus = document.getElementById("paa-form-status");
            const paaSyncStatus = document.getElementById("paa-sync-status");
            const paaHistoryGroups = document.getElementById("paa-history-groups");
            const paaEmptyState = document.getElementById("paa-empty-state");
            const attendanceTab = document.getElementById("attendance-tab");
            const paaTab = document.getElementById("paa-tab");
            const queuesTab = document.getElementById("queues-tab");
            const chatToggle = document.getElementById("chat-toggle");
            const attendancePanel = document.getElementById("attendance-panel");
            const paaPanel = document.getElementById("paa-panel");
            const queuesPanel = document.getElementById("queues-panel");
            const queuePanelContentElement = document.getElementById("queue-panel-content");
            const appointmentWorkspace = document.querySelector(".workspace");
            const appointmentPrimaryColumn = document.querySelector(".primary-column");
            const chatPanel = document.getElementById("chat-panel");
            const hostedAppsScript = Boolean(window.google?.script?.run);
            const mobileClient = Boolean(window.CRASMobile);
            const queueDashboards = document.querySelector(".queue-dashboards");
            const queueDashboardsHome = queueDashboards?.parentElement || null;
            let dashboardLayout = createDefaultDashboardLayout();
            let dashboardLayoutDraft = null;
            const historySuggestionElements = {
                nome: document.getElementById("name-history-suggestions"),
                cpf: document.getElementById("cpf-history-suggestions"),
                telefone: document.getElementById("phone-history-suggestions"),
                endereco: document.getElementById("address-history-suggestions")
            };
            const historyAutocompleteInputs = {
                nome: nameInput,
                cpf: cpfInput,
                telefone: phoneInput,
                endereco: addressInput
            };
            const routeQueueOverlay = document.getElementById("route-queue-overlay");
            const routeQueueDialog = routeQueueOverlay.querySelector(".route-queue-dialog");
            const newRouteInput = document.getElementById("new-route");
            const routeQueueAssistance = document.getElementById("new-route-tag-assistencia");
            const routeQueueCadastro = document.getElementById("new-route-tag-cadastro");
            const routeQueueNone = document.getElementById("new-route-tag-none");
            const routeQueueChoiceInputs = [routeQueueAssistance, routeQueueCadastro, routeQueueNone];
            const confirmRouteQueueButton = document.getElementById("confirm-route-queue");
            const queueFollowupOverlay = document.getElementById("queue-followup-overlay");
            const queueFollowupMessage = document.getElementById("queue-followup-message");
            const queueFollowupNo = document.getElementById("queue-followup-no");
            const queueFollowupYes = document.getElementById("queue-followup-yes");
            let editingAppointmentId = null;
            let editingPaaRecordId = null;
            let appointmentDateEdited = false;
            let selectedAssistantValue = "";
            let pendingRouteName = "";
            let historyUndoAction = null;
            let pendingDeleteRecordId = null;
            let pendingDeleteServiceId = null;
            let deleteConfirmTrigger = null;
            let appointmentAnnotationsRecordId = null;
            let appointmentAnnotationsTrigger = null;
            let pendingAutocompletePeople = [];
            let autocompleteTrigger = null;
            let observedDayKey = "";
            let queueCleanupDayKey = "";
            let dayRefreshPromise = null;
            let dayRefreshTimer = null;
            let pendingQueuePrompt = null;
            let queuePromptReturnFocus = null;
            let queueTimerRunning = false;
            let lastFormActivityAt = 0;
            const storageCache = new Map();
            const database = new Dexie("cras-ouro-preto");
            database.version(1).stores({
                appointments: "&id, createdAt, cpf",
                settings: "&key"
            });

            // --- Estrutura da aplicação ---
            const appConfig = {
                sync: {
                    timeoutMs: 30000
                },
                storage: {
                    records: STORAGE_RECORDS,
                    routes: STORAGE_ROUTES,
                    preferences: STORAGE_PREFERENCES,
                    assistants: STORAGE_ASSISTANTS,
                    nationalities: STORAGE_NATIONALITIES,
                    routeQueueTags: STORAGE_ROUTE_QUEUE_TAGS,
                    paaRecords: STORAGE_PAA_RECORDS,
                    syncBase: STORAGE_SYNC_BASE,
                    legacyEthnicities: LEGACY_STORAGE_ETHNICITIES,
                    migrationMarker: STORAGE_MIGRATION_MARKER
                },
                queue: {
                    tags: QUEUE_TAGS,
                    none: QUEUE_TAG_NONE,
                    promptDelay: QUEUE_PROMPT_DELAY,
                    duration: ASSISTANCE_DURATION,
                    formIdleDelay: FORM_IDLE_DELAY
                }
            };

            const appState = {
                cache: storageCache,
                database,
                sync: {
                    pendingCalls: new Map(),
                    bridgeReady: false,
                    bridgeTarget: null,
                    lastSnapshot: null
                },
                ui: {
                    editingAppointmentId,
                    editingPaaRecordId,
                    appointmentDateEdited,
                    selectedAssistantValue,
                    pendingRouteName,
                    historyUndoAction,
                    pendingDeleteRecordId,
                    deleteConfirmTrigger,
                    pendingAutocompletePeople,
                    autocompleteTrigger,
                    observedDayKey,
                    queueCleanupDayKey,
                    dayRefreshPromise,
                    dayRefreshTimer,
                    pendingQueuePrompt,
                    queuePromptReturnFocus,
                    queueTimerRunning,
                    lastFormActivityAt
                }
            };

            const CRASApp = {
                config: appConfig,
                state: appState,
                storage: {
                    cache: storageCache,
                    db: database,
                    read: (key) => storageCache.get(key),
                    write: (key, value) => {
                        storageCache.set(key, value);
                        localStorage.setItem(key, JSON.stringify(value));
                    }
                },
                sync: {
                    synchronize: () => syncWithGoogle(true)
                },
                bootstrap: async () => {
                    await initializeStorage();
                    await refreshCurrentDay();
                }
            };

            Object.defineProperty(window, "CRASApp", {
                value: CRASApp,
                writable: false,
                configurable: true
            });

            function readStorage(key, fallback) {
                return storageCache.has(key) ? storageCache.get(key) : fallback;
            }

            function createDefaultDashboardLayout() {
                const widgetIds = DASHBOARD_WIDGETS.map(widget => widget.id);
                return {
                    version: DASHBOARD_LAYOUT_VERSION,
                    visible: [...widgetIds],
                    order: [...widgetIds]
                };
            }

            function normalizeDashboardLayout(value) {
                if (!value || typeof value !== "object" || value.version !== DASHBOARD_LAYOUT_VERSION
                    || !Array.isArray(value.visible) || !Array.isArray(value.order)) {
                    return createDefaultDashboardLayout();
                }
                const validIds = new Set(DASHBOARD_WIDGETS.map(widget => widget.id));
                const uniqueValues = values => [...new Set(values.filter(id => validIds.has(id)))];
                const order = uniqueValues(value.order);
                DASHBOARD_WIDGETS.forEach(widget => {
                    if (!order.includes(widget.id)) order.push(widget.id);
                });
                return {
                    version: DASHBOARD_LAYOUT_VERSION,
                    visible: uniqueValues(value.visible),
                    order
                };
            }

            function dashboardLayoutStorageKey(userId) {
                return `${STORAGE_DASHBOARD_LAYOUT_PREFIX}${encodeURIComponent(userId)}`;
            }

            function loadDashboardLayout(userId) {
                try {
                    const raw = localStorage.getItem(dashboardLayoutStorageKey(userId));
                    return raw === null ? createDefaultDashboardLayout() : normalizeDashboardLayout(JSON.parse(raw));
                } catch (error) {
                    console.error("Não foi possível carregar a personalização do painel.", error);
                    showToast("Não foi possível carregar o painel personalizado. O padrão será usado neste acesso.");
                    return createDefaultDashboardLayout();
                }
            }

            function applyDashboardLayout() {
                const visibleWidgets = new Set(dashboardLayout.visible);
                dashboardLayout.order.forEach((widgetId, index) => {
                    const element = document.querySelector(`[data-dashboard-widget="${widgetId}"]`);
                    if (!element) return;
                    element.style.order = String(index);
                    element.hidden = !visibleWidgets.has(widgetId) || element.dataset.roleVisible === "false";
                });
            }

            function renderDashboardCustomizer() {
                const list = document.getElementById("dashboard-customizer-list");
                if (!dashboardLayoutDraft) {
                    list.replaceChildren();
                    return;
                }
                const visibleWidgets = new Set(dashboardLayoutDraft.visible);
                list.innerHTML = dashboardLayoutDraft.order.map((widgetId, index) => {
                    const widget = DASHBOARD_WIDGETS.find(item => item.id === widgetId);
                    if (!widget) return "";
                    return `<li data-dashboard-customizer-widget="${widget.id}">
                        <label><input type="checkbox" data-dashboard-visible="${widget.id}" ${visibleWidgets.has(widget.id) ? "checked" : ""}> <span>${widget.label}</span></label>
                        <div class="dashboard-customizer-move">
                            <button class="button-secondary" type="button" data-dashboard-move="up" data-widget-id="${widget.id}" aria-label="Mover ${widget.label} para cima" ${index === 0 ? "disabled" : ""}>Subir</button>
                            <button class="button-secondary" type="button" data-dashboard-move="down" data-widget-id="${widget.id}" aria-label="Mover ${widget.label} para baixo" ${index === dashboardLayoutDraft.order.length - 1 ? "disabled" : ""}>Descer</button>
                        </div>
                    </li>`;
                }).join("");
            }

            function openDashboardCustomizer() {
                if (!activeUser) return;
                dashboardLayoutDraft = {
                    version: DASHBOARD_LAYOUT_VERSION,
                    visible: [...dashboardLayout.visible],
                    order: [...dashboardLayout.order]
                };
                renderDashboardCustomizer();
                document.getElementById("dashboard-customizer-status").textContent =
                    `Personalização de ${activeUser.name}. As alterações entram em vigor após salvar.`;
                document.getElementById("dashboard-customizer").hidden = false;
                document.getElementById("dashboard-customize-toggle").setAttribute("aria-expanded", "true");
                document.getElementById("dashboard-customizer-title").focus();
            }

            function closeDashboardCustomizer(returnFocus = true) {
                document.getElementById("dashboard-customizer").hidden = true;
                document.getElementById("dashboard-customize-toggle").setAttribute("aria-expanded", "false");
                dashboardLayoutDraft = null;
                if (returnFocus && activeUser) document.getElementById("dashboard-customize-toggle").focus();
            }

            function saveDashboardLayout(layout) {
                const updatedLayout = normalizeDashboardLayout(layout);
                if (!activeUser) return false;
                try {
                    localStorage.setItem(dashboardLayoutStorageKey(activeUser.id), JSON.stringify(updatedLayout));
                } catch (error) {
                    console.error("Não foi possível salvar a personalização do painel.", error);
                    document.getElementById("dashboard-customizer-status").textContent =
                        "Não foi possível salvar neste dispositivo. Verifique o espaço disponível e tente novamente.";
                    showToast("Não foi possível salvar a personalização do painel neste dispositivo.");
                    return false;
                }
                dashboardLayout = updatedLayout;
                applyDashboardLayout();
                document.getElementById("dashboard-customizer-status").textContent = "Painel salvo neste dispositivo.";
                return true;
            }

            async function initializeStorage() {
                await database.open();
                const migration = await database.settings.get(STORAGE_MIGRATION_MARKER);
                let migratedRecords = null;
                if (!migration) {
                    let legacyRecords = [];
                    const legacySettings = [];
                    const migratedKeys = [];
                    const legacyKeys = [STORAGE_RECORDS, ...STORAGE_SETTINGS_KEYS];
                    try {
                        legacyKeys.forEach(key => {
                            const raw = localStorage.getItem(key);
                            if (raw === null) return;
                            const value = JSON.parse(raw);
                            migratedKeys.push(key);
                            if (key === STORAGE_RECORDS) {
                                if (Array.isArray(value)) legacyRecords = value;
                            } else {
                                legacySettings.push({ key, value });
                            }
                        });
                    } catch (error) {
                        console.error("Falha ao ler dados antigos do navegador.", error);
                        throw new Error("Não foi possível migrar os dados antigos. Eles continuam preservados no armazenamento anterior.");
                    }
                    await database.transaction("rw", database.appointments, database.settings, async () => {
                        if (legacyRecords.length) await database.appointments.bulkPut(legacyRecords);
                        for (const setting of legacySettings) {
                            if (!await database.settings.get(setting.key)) await database.settings.put(setting);
                        }
                        await database.settings.put({ key: STORAGE_MIGRATION_MARKER, value: true });
                    });
                    migratedRecords = legacyRecords;
                    try {
                        migratedKeys.forEach(key => localStorage.removeItem(key));
                    } catch (error) {
                        console.error("Não foi possível liberar todo o armazenamento antigo.", error);
                    }
                }
                const records = migratedRecords ?? await database.appointments.toArray();
                storageCache.set(STORAGE_RECORDS, records);
                for (const key of STORAGE_SETTINGS_KEYS) {
                    const setting = await database.settings.get(key);
                    if (setting) storageCache.set(key, setting.value);
                }
                const historyPresetSetting = await database.settings.get(STORAGE_HISTORY_FILTER_PRESETS);
                if (historyPresetSetting) storageCache.set(STORAGE_HISTORY_FILTER_PRESETS, historyPresetSetting.value);
            }

            try {
                await initializeStorage();
            } catch (error) {
                console.error("Não foi possível inicializar o IndexedDB.", error);
                window.alert("Não foi possível acessar o armazenamento local deste aplicativo. Os dados antigos não foram removidos.");
                return;
            }
            let appointments = readStorage(STORAGE_RECORDS, []);
            if (!Array.isArray(appointments)) appointments = [];
            let people = readStorage(STORAGE_PEOPLE, []);
            if (!Array.isArray(people)) people = [];
            let historyFilterPresets = readStorage(STORAGE_HISTORY_FILTER_PRESETS, []);
            if (!Array.isArray(historyFilterPresets)) historyFilterPresets = [];
            renderHistoryFilterPresets("");
            let paaRecords = readStorage(STORAGE_PAA_RECORDS, []);
            if (!Array.isArray(paaRecords)) paaRecords = [];
            let assistants = readStorage(STORAGE_ASSISTANTS, null);
            if (!Array.isArray(assistants)) assistants = DEFAULT_ASSISTANTS.map(assistant => ({ ...assistant }));
            assistants = assistants.filter(assistant => assistant && typeof assistant.name === "string" && assistant.name.trim()
                && typeof assistant.color === "string" && /^#[0-9a-f]{6}$/i.test(assistant.color))
                .map(assistant => ({ name: assistant.name.trim(), color: assistant.color.toLowerCase() }));
            assistants = assistants.filter((assistant, index) => assistants.findIndex(item => item.name.toLocaleLowerCase("pt-BR") === assistant.name.toLocaleLowerCase("pt-BR")) === index);
            if (!assistants.length) assistants = DEFAULT_ASSISTANTS.map(assistant => ({ ...assistant }));
            let users = readStorage(STORAGE_USERS, null);
            if (!Array.isArray(users)) {
                users = assistants.map((assistant, index) => ({
                    id: `assistant-${index + 1}`,
                    name: assistant.name,
                    color: assistant.color,
                    role: assistant.name.toLocaleLowerCase("pt-BR") === "daiane" ? "admin" : "assistant",
                    canAttendTechnical: assistant.name.toLocaleLowerCase("pt-BR") === "daiane"
                }));
            }
            users = users.filter(user => user && typeof user.name === "string" && user.name.trim()
                && typeof user.color === "string" && /^#[0-9a-f]{6}$/i.test(user.color)
                && ["assistant", "caseworker", "reception", "intern", "admin"].includes(user.role))
                .map(user => ({
                    id: typeof user.id === "string" && user.id ? user.id : createUserId(),
                    name: user.name.trim(),
                    color: user.color.toLowerCase(),
                    role: user.role,
                    canAttendTechnical: user.role === "admin" && user.canAttendTechnical === true,
                    ...(user.passwordCredential
                        && typeof user.passwordCredential.salt === "string"
                        && typeof user.passwordCredential.hash === "string"
                        && /^[a-f0-9]{64}$/i.test(user.passwordCredential.hash)
                        ? { passwordCredential: {
                            salt: user.passwordCredential.salt,
                            hash: user.passwordCredential.hash.toLowerCase()
                        } }
                        : {})
                }))
                .filter((user, index, list) => list.findIndex(item => item.id === user.id) === index);
            if (!users.length) users = DEFAULT_ASSISTANTS.map((assistant, index) => ({
                id: `assistant-${index + 1}`,
                ...assistant,
                role: assistant.name.toLocaleLowerCase("pt-BR") === "daiane" ? "admin" : "assistant",
                canAttendTechnical: assistant.name.toLocaleLowerCase("pt-BR") === "daiane"
            }));
            const existingSystemAdmin = users.find(user =>
                user.id === SYSTEM_ADMIN_USER_ID
                || user.name.toLocaleLowerCase("pt-BR") === SYSTEM_ADMIN_NAME);
            const systemAdmin = {
                id: SYSTEM_ADMIN_USER_ID,
                name: SYSTEM_ADMIN_NAME,
                color: existingSystemAdmin?.color || "#244b3b",
                role: "admin",
                canAttendTechnical: existingSystemAdmin?.canAttendTechnical === true
            };
            users = [
                systemAdmin,
                ...users.filter(user => user.id !== SYSTEM_ADMIN_USER_ID
                    && user.name.toLocaleLowerCase("pt-BR") !== SYSTEM_ADMIN_NAME)
            ];
            try {
                const daianeAdminMigration = await database.settings.get(STORAGE_DAIANE_ADMIN_MIGRATION);
                if (daianeAdminMigration?.value !== true) {
                    users = users.map(user => user.name.toLocaleLowerCase("pt-BR") === "daiane"
                        ? { ...user, role: "admin", canAttendTechnical: true }
                        : user);
                }
                const initialAssistants = users
                    .filter(user => user.role === "assistant" || user.role === "admin" && user.canAttendTechnical)
                    .map(({ name, color }) => ({ name, color }));
                await database.transaction("rw", database.settings, async () => {
                    await database.settings.bulkPut([
                        { key: STORAGE_USERS, value: users },
                        { key: STORAGE_ASSISTANTS, value: initialAssistants },
                        { key: STORAGE_DAIANE_ADMIN_MIGRATION, value: true }
                    ]);
                });
                storageCache.set(STORAGE_USERS, users);
                storageCache.set(STORAGE_ASSISTANTS, initialAssistants);
            } catch (error) {
                console.error("Não foi possível preparar as contas administrativas iniciais.", error);
                dismissBootScreen();
                window.alert("Não foi possível preparar as contas administrativas iniciais. Os dados existentes foram preservados.");
                return;
            }
            assistants = users.filter(isTechnicalUser)
                .map(({ name, color }) => ({ name, color }));
            let activeUser = null;
            let technicalEncryptionKey = null;
            const technicalPlaintextCache = new Map();
            let rememberedUserId = "";
            let currentMainTab = "attendance";
            let routes = readStorage(STORAGE_ROUTES, null);
            if (!Array.isArray(routes)) routes = [...DEFAULT_ROUTES];
            routes = routes.filter(route => typeof route === "string" && route.trim());
            const savedRouteQueueTags = readStorage(STORAGE_ROUTE_QUEUE_TAGS, {});
            let routeQueueTags = { ...DEFAULT_ROUTE_QUEUE_TAGS };
            if (savedRouteQueueTags && typeof savedRouteQueueTags === "object" && !Array.isArray(savedRouteQueueTags)) {
                Object.entries(savedRouteQueueTags).forEach(([route, tags]) => {
                    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== "string")) return;
                    const normalized = [...new Set(tags.map(tag => tag.trim().toLocaleLowerCase("pt-BR")))];
                    const hasNone = normalized.includes(QUEUE_TAG_NONE);
                    const validQueueTags = normalized.filter(tag => Object.values(QUEUE_TAGS).includes(tag));
                    if (hasNone && validQueueTags.length || !hasNone && !validQueueTags.length) return;
                    routeQueueTags[route] = hasNone ? [QUEUE_TAG_NONE] : validQueueTags;
                });
            }
            routes.forEach(route => {
                if (!Object.hasOwn(routeQueueTags, route)) routeQueueTags[route] = [QUEUE_TAG_NONE];
            });
            const savedNationalities = readStorage(STORAGE_NATIONALITIES, null)
                ?? readStorage(LEGACY_STORAGE_ETHNICITIES, null);
            let nationalities = savedNationalities === null ? [...DEFAULT_NATIONALITIES] : savedNationalities;
            if (!Array.isArray(nationalities)) nationalities = [...DEFAULT_NATIONALITIES];
            nationalities = nationalities.filter(value => typeof value === "string" && value.trim().length <= 60)
                .map(value => value.trim())
                .filter((value, index, values) => values.findIndex(item => item.toLocaleLowerCase("pt-BR") === value.toLocaleLowerCase("pt-BR")) === index);
            const savedPreferences = readStorage(STORAGE_PREFERENCES, {});
            let preferences = { ...DEFAULT_PREFERENCES, ...savedPreferences };
            const hadLegacyDesktopServerSettings = window.CRASDesktop
                && ["serverEndpoint", "serverToken", "syncEndpoint", "syncToken", "syncPeers"]
                    .some(key => Object.hasOwn(savedPreferences, key));
            if (window.CRASDesktop) {
                ["serverEndpoint", "serverToken", "syncEndpoint", "syncToken", "syncPeers"].forEach(key => {
                    delete preferences[key];
                });
            }
            if (!Array.isArray(preferences.syncPeers)) {
                preferences.syncPeers = preferences.syncEndpoint && preferences.syncToken
                    ? [{ endpoint: preferences.syncEndpoint, token: preferences.syncToken }]
                    : [];
            }
            let syncBaseSnapshot = readStorage(STORAGE_SYNC_BASE, null);
            let peerSyncBaseSnapshots = readStorage(STORAGE_PEER_SYNC_BASES, {});
            if (!peerSyncBaseSnapshots || typeof peerSyncBaseSnapshots !== "object" || Array.isArray(peerSyncBaseSnapshots)) {
                peerSyncBaseSnapshots = {};
            }
            let localNodeBaseSnapshot = readStorage(STORAGE_LOCAL_NODE_BASE_SNAPSHOT, null);
            if (!localNodeBaseSnapshot || !Array.isArray(localNodeBaseSnapshot.appointments)
                || !Array.isArray(localNodeBaseSnapshot.paaRecords) || !localNodeBaseSnapshot.settings) {
                localNodeBaseSnapshot = null;
            }
            let syncInProgress = false;
            let syncStartupInProgress = false;
            let syncStatusTimer = null;
            let syncChangeTimer = null;
            let activationSyncTimer = null;
            let appointmentDraftTimer = null;
            let syncPendingChanges = false;
            let syncConnectionUnavailable = false;
            let latestAutomaticBackup = null;
            let lastSuccessfulSyncAt = Number(readStorage(STORAGE_LAST_SUCCESSFUL_SYNC, 0)) || 0;
            let syncRequestedAfterCurrent = false;
            let queuedSyncRole = null;
            let syncBridgeReady = false;
            let syncBridgeTarget = null;
            const syncBridgeFrame = document.getElementById("sync-bridge");
            const pendingSyncCalls = new Map();
            let accessToken = "";
            let offlineMode = false;
            let desktopNodeInfo = null;
            let mobileAccessKey = null;
            let mobileServerVersion = "";
            let mobileOfflineMode = false;
            let mobilePendingSync = false;
            let mobileOfflineCredentials = { info: null, proof: null, key: null };
            let mobileNodeRevision = 0;
            let mobileNodeBaseSnapshot = null;
            let mobileRefreshInProgress = false;
            let activePeerId = "";
            let localNodeRevision = Number(readStorage(STORAGE_LOCAL_NODE_REVISION, 0)) || 0;
            let localNodeRefreshInProgress = false;
            let localSnapshotPersistTimer = null;

            function updateSyncIndicator() {
                const indicator = document.getElementById("sync-indicator");
                if (!indicator) return;
                let state = "idle";
                let message = "Dados salvos neste dispositivo";
                if (!navigator.onLine || offlineMode || mobileOfflineMode) {
                    state = "offline";
                    message = "Offline · alterações salvas neste dispositivo";
                } else if (syncInProgress) {
                    state = "syncing";
                    message = "Sincronizando…";
                } else if (mobilePendingSync || syncPendingChanges) {
                    state = "pending";
                    message = "Sincronização pendente";
                } else if (syncConnectionUnavailable) {
                    state = "offline";
                    message = "Servidor indisponível · dados salvos localmente";
                } else if (window.CRASDesktop && desktopNodeInfo?.centralServer) {
                    message = "Servidor central · dados salvos localmente";
                } else if (window.CRASDesktop) {
                    message = "Dados locais · aguardando servidor central";
                } else if (mobileClient && mobileAccessKey) {
                    message = "Conectado ao servidor CRAS";
                } else if (hostedAppsScript || preferences.syncEndpoint) {
                    message = "Sincronização automática ativa";
                }
                indicator.textContent = message;
                indicator.dataset.state = state;
                updateAdminOperationsStatus();
            }

            function updateAdminOperationsStatus() {
                const status = document.getElementById("admin-operations-status");
                if (!status || !activeUser || activeUser.role !== "admin") return;
                const connection = !navigator.onLine || syncConnectionUnavailable
                    ? "Conexão indisponível"
                    : syncInProgress
                        ? "Sincronizando"
                        : "Conexão disponível";
                const lastSync = lastSuccessfulSyncAt
                    ? formatDateTime(lastSuccessfulSyncAt)
                    : "Nenhuma sincronização concluída neste dispositivo";
                status.textContent =
                    `${connection} · Última sincronização: ${lastSync} · ${appointments.length} atendimentos · ${paaRecords.length} registros do PAA.`;
            }

            function updateServerTransferControls() {
                const exportButton = document.getElementById("server-transfer-export");
                const importButton = document.getElementById("server-transfer-import");
                exportButton.hidden = !window.CRASDesktop;
                importButton.hidden = !window.CRASDesktop;
                exportButton.disabled = !desktopNodeInfo?.centralServer || desktopNodeInfo.ready !== true;
                importButton.disabled = !desktopNodeInfo || desktopNodeInfo.centralServer === true;
            }

            async function updateMachineExportStatus() {
                const status = document.getElementById("machine-data-export-status");
                if (!status || !activeUser || activeUser.role !== "admin") return;
                updateServerTransferControls();
                if (!window.CRASDesktop) {
                    status.textContent = "A exportação JSON automática está disponível no servidor CRAS Desktop.";
                    return;
                }
                try {
                    const response = await fetch("/api/machine-export-status", { cache: "no-store" });
                    const result = await response.json();
                    if (!response.ok) {
                        throw new Error(result.error || "Não foi possível consultar a exportação JSON.");
                    }
                    if (desktopNodeInfo) desktopNodeInfo.ready = result.ready === true;
                    updateServerTransferControls();
                    if (!result.enabled) {
                        status.textContent = "Este computador não é o servidor central; o arquivo é atualizado no notebook servidor.";
                    } else if (result.error) {
                        status.textContent = `Falha ao atualizar o arquivo JSON externo: ${result.error}`;
                    } else if (!result.ready || !result.exportedAt) {
                        status.textContent = "Aguardando a primeira sincronização para criar o arquivo JSON externo.";
                    } else {
                        status.textContent =
                            `JSON atualizado em ${formatDateTime(result.exportedAt)} · revisão ${result.revision} · ${result.path}`;
                    }
                } catch (error) {
                    console.error("Não foi possível consultar o estado da exportação JSON.", error);
                    status.textContent = `Não foi possível consultar o arquivo JSON externo: ${error.message}`;
                }
            }

            async function rememberSuccessfulSync() {
                const syncedAt = Date.now();
                lastSuccessfulSyncAt = syncedAt;
                try {
                    await database.settings.put({
                        key: STORAGE_LAST_SUCCESSFUL_SYNC,
                        value: syncedAt
                    });
                    storageCache.set(STORAGE_LAST_SUCCESSFUL_SYNC, syncedAt);
                } catch (error) {
                    console.error("A sincronização foi concluída, mas não foi possível salvar seu horário.", error);
                }
                updateAdminOperationsStatus();
            }

            function applyPreferences() {
                document.body.classList.toggle("dark-mode", Boolean(preferences.darkMode));
                document.body.classList.toggle("high-contrast", Boolean(preferences.highContrast));
                document.body.classList.toggle("reduce-motion", Boolean(preferences.reduceMotion));
                document.body.dataset.colorTheme = ["green", "blue", "violet", "teal", "terracotta", "amber", "rose", "slate"].includes(preferences.colorTheme)
                    ? preferences.colorTheme
                    : "green";
                document.body.style.zoom = ["1", "1.1", "1.2", "1.3"].includes(String(preferences.fontScale)) ? String(preferences.fontScale) : "1";
                document.body.classList.toggle("hide-hints", !preferences.showHints);
                document.querySelector("meta[name='theme-color']").content = preferences.darkMode ? "#141d18" : "#f1f6fa";
                document.getElementById("theme-toggle").checked = Boolean(preferences.darkMode);
                document.getElementById("contrast-toggle").checked = Boolean(preferences.highContrast);
                document.getElementById("motion-toggle").checked = Boolean(preferences.reduceMotion);
                document.getElementById("color-theme").value = document.body.dataset.colorTheme;
                document.getElementById("font-size").value = document.body.style.zoom;
                document.getElementById("hints-toggle").checked = Boolean(preferences.showHints);
                document.getElementById("sync-messages-toggle").checked = preferences.showSyncMessages !== false;
                document.getElementById("history-autocomplete-toggle").checked = Boolean(preferences.autoCompleteHistory);
                document.getElementById("paa-enabled-toggle").checked = Boolean(preferences.paaEnabled);
                document.getElementById("principal-computer-toggle").checked = Boolean(preferences.isPrincipalComputer);
                document.getElementById("principal-computer-setting").hidden = activeUser?.role !== "admin";
                document.getElementById("principal-backup-hint").hidden = activeUser?.role !== "admin";
                document.getElementById("principal-backup-status").hidden =
                    activeUser?.role !== "admin" || !window.CRASDesktop;
                const syncUrlInput = document.getElementById("sync-app-url");
                const syncKeyInput = document.getElementById("sync-peer-key");
                if (syncUrlInput) syncUrlInput.value = preferences.syncEndpoint || "";
                if (syncKeyInput) syncKeyInput.value = preferences.syncToken || "";
                document.getElementById("paa-google-sheet-url").value = preferences.googleSheetEndpoint || "";
                paaTab.hidden = !preferences.paaEnabled;
                chatToggle.hidden = hostedAppsScript;
                if (chatToggle.hidden) setChatPopupOpen(false);
                if (!preferences.paaEnabled && !paaPanel.hidden) selectMainTab(hostedAppsScript ? "queues" : "attendance");
                applyActiveUserLayout();
                configureSyncBridge();
                updateSyncIndicator();
            }

            async function updatePreferences(changes) {
                const updated = { ...preferences, ...changes };
                if (!await saveStorage(STORAGE_PREFERENCES, updated)) {
                    applyPreferences();
                    return false;
                }
                preferences = updated;
                applyPreferences();
                return true;
            }

            function applyActiveUserLayout() {
                const role = activeUser?.role || "";
                document.body.dataset.userRole = role;
                const isStaff = role === "assistant" || role === "caseworker";
                const mobileIntern = mobileClient && role === "intern";
                staffHistoryPanel.hidden = !isStaff;
                queuesTab.hidden = !isStaff && !hostedAppsScript && !mobileIntern;
                document.getElementById("principal-computer-setting").hidden = role !== "admin";
                document.getElementById("principal-backup-hint").hidden = role !== "admin";
                document.getElementById("admin-operations-card").hidden = role !== "admin";
                document.getElementById("central-server-role-setting").hidden =
                    !window.CRASDesktop || role !== "admin";
                document.getElementById("add-route-form").hidden = isStaff;
                document.querySelector(".field-assistant").hidden = role === "caseworker";
                document.getElementById("settings-switch-user").hidden = !activeUser;
                document.getElementById("assistant-admin-open").hidden = activeUser?.role !== "admin";
                document.getElementById("dashboard-customize-toggle").hidden = !activeUser;
                document.getElementById("quick-new-appointment").hidden = isStaff;
                document.getElementById("quick-open-queues").hidden = queuesTab.hidden;
                document.querySelector('[data-dashboard-widget="quick-actions"]').dataset.roleVisible =
                    String(!isStaff || !queuesTab.hidden);
                document.getElementById("active-user-label").textContent = activeUser
                    ? `${activeUser.name} · ${userRoleLabel(activeUser.role)}${activeUser.canAttendTechnical ? " · Técnico" : ""}`
                    : "";
                renderAssistants();
                renderRoutes();
                if (isStaff || mobileIntern) {
                    if (queueDashboards && queueDashboards.parentElement !== queuesPanel) {
                        queuePanelContentElement.appendChild(queueDashboards);
                    }
                    if (isStaff) {
                        queuePanelContentElement.insertBefore(appointmentPrimaryColumn, queuePanelContentElement.firstChild);
                        formTitle.textContent = "Registrar atendimento manual";
                        document.getElementById("appointment-form-note").textContent =
                            "O registro será salvo neste computador como atendimento concluído e sincronizado com o servidor quando houver conexão.";
                    }
                    attendancePanel.hidden = isStaff;
                    selectMainTab("queues");
                    applyDashboardLayout();
                    return;
                }
                if (queueDashboards && queueDashboardsHome && queueDashboards.parentElement !== queueDashboardsHome) {
                    queueDashboardsHome.appendChild(queueDashboards);
                }
                if (appointmentPrimaryColumn.parentElement !== appointmentWorkspace) {
                    appointmentWorkspace.insertBefore(appointmentPrimaryColumn, appointmentWorkspace.firstChild);
                }
                if (!editingAppointmentId) {
                    formTitle.textContent = "Atendimento";
                    document.getElementById("appointment-form-note").textContent =
                        "Preencha os dados da pessoa e depois os do atendimento. Campos com * são obrigatórios.";
                }
                attendancePanel.hidden = false;
                selectMainTab(hostedAppsScript && currentMainTab === "attendance"
                    ? "queues"
                    : mobileIntern && currentMainTab === "attendance"
                        ? "queues"
                        : currentMainTab);
                applyDashboardLayout();
                updateAdminOperationsStatus();
                void updateMachineExportStatus();
            }

            function userRoleLabel(role) {
                return ({
                    assistant: "Técnico",
                    caseworker: "Cadastradora",
                    reception: "Recepção",
                    intern: "Estagiário",
                    admin: "Admin"
                })[role] || "Usuário";
            }

            function isTechnicalUser(user) {
                return user?.role === "assistant"
                    || user?.role === "admin" && user.canAttendTechnical === true;
            }

            function createUserId() {
                return window.crypto?.randomUUID
                    ? window.crypto.randomUUID()
                    : `user-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            }

            async function hashUserPassword(password, salt) {
                if (!window.crypto?.subtle) {
                    throw new Error("Este ambiente não oferece criptografia para validar a senha.");
                }
                const material = await window.crypto.subtle.importKey(
                    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
                const digest = await window.crypto.subtle.deriveBits({
                    name: "PBKDF2",
                    salt,
                    iterations: 150000,
                    hash: "SHA-256"
                }, material, 256);
                return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
            }

            async function createUserPasswordCredential(password) {
                const salt = window.crypto.getRandomValues(new Uint8Array(16));
                return {
                    salt: bytesToBase64(salt),
                    hash: await hashUserPassword(password, salt)
                };
            }

            function renderLoginUsers() {
                const loginName = document.getElementById("login-user");
                const rememberedUser = users.find(user => user.id === rememberedUserId);
                document.getElementById("login-user-list").innerHTML = users.map(user =>
                    `<option value="${escapeHtml(user.name)}">${escapeHtml(userRoleLabel(user.role))}</option>`
                ).join("");
                if (!loginName.value && rememberedUser) {
                    loginName.value = rememberedUser.name;
                    document.getElementById("login-role").value = rememberedUser.role;
                }
                updateLoginPasswordFields();
                renderChatRecipients();
            }

            function updateLoginPasswordFields() {
                const loginName = document.getElementById("login-user").value.trim().toLocaleLowerCase("pt-BR");
                const selectedRole = document.getElementById("login-role").value;
                const selectedUser = users.find(user =>
                    user.name.toLocaleLowerCase("pt-BR") === loginName && user.role === selectedRole);
                const passwordWrap = document.getElementById("login-password-wrap");
                const confirmWrap = document.getElementById("login-password-confirm-wrap");
                const passwordInput = document.getElementById("login-password");
                const confirmInput = document.getElementById("login-password-confirm");
                const needsPasswordSetup = Boolean(selectedUser && !selectedUser.passwordCredential);
                const serverPasswordToggle = document.getElementById("login-server-password-toggle");
                if (!selectedUser) loginServerPasswordMode = false;
                const useServerPassword = Boolean(selectedUser && loginServerPasswordMode);
                passwordWrap.hidden = !selectedUser;
                confirmWrap.hidden = !needsPasswordSetup || useServerPassword;
                passwordInput.required = Boolean(selectedUser);
                confirmInput.required = needsPasswordSetup && !useServerPassword;
                passwordInput.autocomplete = needsPasswordSetup && !useServerPassword
                    ? "new-password" : "current-password";
                document.getElementById("login-password-label").textContent = useServerPassword
                    ? "Senha cadastrada no servidor"
                    : needsPasswordSetup
                    ? "Crie sua senha (mínimo 8 caracteres)"
                    : "Senha individual";
                serverPasswordToggle.hidden = !selectedUser || !window.CRASDesktop;
                serverPasswordToggle.textContent = useServerPassword
                    ? "Primeiro acesso? Criar senha neste PC"
                    : "Já tenho senha no servidor";
            }

            function showUserLogin(preferredUserId = rememberedUserId) {
                closeDashboardCustomizer(false);
                activeUser = null;
                appointments = lockTechnicalAnnotations(appointments);
                storageCache.set(STORAGE_RECORDS, appointments);
                appointmentAnnotationsOverlay.hidden = true;
                appointmentAnnotationsCategories.innerHTML = "";
                dashboardLayout = createDefaultDashboardLayout();
                loginServerPasswordMode = false;
                document.body.removeAttribute("data-user-role");
                document.getElementById("user-login-status").textContent = "";
                document.getElementById("login-password").value = "";
                document.getElementById("login-password-confirm").value = "";
                renderLoginUsers();
                const preferredUser = users.find(user => user.id === preferredUserId);
                if (preferredUser) {
                    document.getElementById("login-user").value = preferredUser.name;
                    document.getElementById("login-role").value = preferredUser.role;
                    loginServerPasswordMode = !preferredUser.passwordCredential && Boolean(window.CRASDesktop);
                }
                document.getElementById("user-login").hidden = false;
                document.getElementById("login-user").focus();
                updateLoginPasswordFields();
                applyActiveUserLayout();
            }

            function transitionWithWave(callback) {
                if (preferences.reduceMotion) {
                    callback();
                    return;
                }
                const wave = document.getElementById("screen-wave");
                wave.hidden = false;
                wave.classList.remove("is-active");
                requestAnimationFrame(() => wave.classList.add("is-active"));
                window.setTimeout(() => {
                    callback();
                    wave.classList.remove("is-active");
                    wave.hidden = true;
                }, 480);
            }

            async function activateUser(selectedUser, animate = false) {
                let technicalAccess = null;
                if (selectedUser.role === "assistant") {
                    if (!storageCache.has(STORAGE_TECHNICAL_E2EE)) {
                        if (!window.CRASDesktop || desktopNodeInfo?.centralServer !== true) {
                            showToast("A configuração inicial da chave deve ser feita por uma Técnica no computador servidor central.", "error");
                            return false;
                        }
                        try {
                            appointments = await database.appointments.toArray();
                            storageCache.set(STORAGE_RECORDS, appointments);
                            await refreshLocalNodeFromServer(true, false);
                        } catch (error) {
                            appointments = lockTechnicalAnnotations(appointments);
                            storageCache.set(STORAGE_RECORDS, appointments);
                            showToast(`Não foi possível atualizar os dados antes da migração: ${error.message}`, "error");
                            return false;
                        }
                    }
                    try {
                        technicalAccess = await requestTechnicalKey();
                    } catch (error) {
                        appointments = lockTechnicalAnnotations(appointments);
                        storageCache.set(STORAGE_RECORDS, appointments);
                        showToast(error.message || "Não foi possível desbloquear os registros técnicos.", "error");
                        return false;
                    }
                    if (!technicalAccess) {
                        appointments = lockTechnicalAnnotations(appointments);
                        storageCache.set(STORAGE_RECORDS, appointments);
                        return false;
                    }
                    technicalEncryptionKey = technicalAccess.key;
                }
                const rememberUserSession = document.getElementById("remember-user-session").checked;
                await database.transaction("rw", database.settings, async () => {
                    await database.settings.put({
                        key: STORAGE_REMEMBER_USER_SESSION,
                        value: rememberUserSession
                    });
                    if (rememberUserSession) {
                        await database.settings.put({ key: STORAGE_LOCAL_ACTIVE_USER, value: selectedUser.id });
                    } else {
                        await database.settings.delete(STORAGE_LOCAL_ACTIVE_USER);
                    }
                });
                rememberedUserId = rememberUserSession ? selectedUser.id : "";
                closeDashboardCustomizer(false);
                dashboardLayout = loadDashboardLayout(selectedUser.id);
                activeUser = {
                    id: selectedUser.id,
                    name: selectedUser.name,
                    role: selectedUser.role,
                    color: selectedUser.color,
                    canAttendTechnical: selectedUser.canAttendTechnical === true
                };
                if (technicalAccess) {
                    try {
                        const localRecords = await database.appointments.toArray();
                        appointments = localRecords;
                        storageCache.set(STORAGE_RECORDS, localRecords);
                        if (!storageCache.has(STORAGE_TECHNICAL_E2EE)) {
                            storageCache.set(STORAGE_TECHNICAL_E2EE, technicalAccess.config);
                            if (!await saveStorage(STORAGE_RECORDS, appointments)
                                || !await saveStorage(STORAGE_TECHNICAL_E2EE, technicalAccess.config)) {
                                throw new Error("Não foi possível migrar as anotações técnicas para a criptografia.");
                            }
                        } else {
                            appointments = await unlockTechnicalAnnotations(localRecords, technicalAccess.key);
                            storageCache.set(STORAGE_RECORDS, appointments);
                            const legacyNotes = appointments.some(record =>
                                getAnnotationEntries(record, "assistencia").length
                                && !record.technicalAnnotationsCiphertext);
                            if (legacyNotes && !await saveStorage(STORAGE_RECORDS, appointments)) {
                                throw new Error("Não foi possível criptografar as anotações técnicas antigas.");
                            }
                        }
                        await redactStoredSyncBases();
                    } catch (error) {
                        technicalEncryptionKey = null;
                        activeUser = null;
                        appointments = lockTechnicalAnnotations(appointments);
                        storageCache.set(STORAGE_RECORDS, appointments);
                        showToast(error.message || "Não foi possível abrir os registros técnicos.", "error");
                        return false;
                    }
                }
                const finishActivation = () => {
                    document.getElementById("user-login").hidden = true;
                    document.getElementById("login-password").value = "";
                    document.getElementById("login-password-confirm").value = "";
                    applyActiveUserLayout();
                    renderChatRecipients();
                    renderAll();
                    loadAppointmentDraft().catch(error => {
                        console.error("Não foi possível carregar o rascunho do atendimento.", error);
                        showToast("Não foi possível consultar o rascunho salvo neste dispositivo.");
                    });
                    scheduleLocalSnapshotPersist(activeUser.role);
                };
                if (animate) transitionWithWave(finishActivation);
                else finishActivation();
                return true;
            }

            async function authenticateUserWithServer(user, password) {
                if (!window.CRASDesktop) {
                    throw new Error("A recuperação da senha pelo servidor está disponível no CRAS Desktop.");
                }
                const localInfoResponse = await fetchPeer("/api/info", { cache: "no-store" }, 5000);
                if (!localInfoResponse.ok) {
                    throw new Error("Não foi possível consultar o estado deste computador.");
                }
                const localInfo = await localInfoResponse.json();
                let endpoint = "";
                if (localInfo.centralServer !== true) {
                    await discoverCentralServer(true);
                    endpoint = centralServerDiscoveryCache
                        ? getSyncBridgeUrl(centralServerDiscoveryCache.endpoint)
                        : "";
                    if (!endpoint) {
                        throw new Error("Servidor central não encontrado. Verifique a rede local e tente novamente.");
                    }
                }
                const readAuthResponse = async response => {
                    try {
                        return await response.json();
                    } catch {
                        throw new Error("O servidor respondeu com dados inválidos. Tente novamente.");
                    }
                };
                const challengeResponse = await fetchPeer(`${endpoint}/api/user/auth-challenge`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ userId: user.id })
                }, 8000);
                const challenge = await readAuthResponse(challengeResponse);
                if (!challengeResponse.ok) {
                    throw new Error(challenge.error || "Não foi possível iniciar a autenticação no servidor.");
                }
                if (typeof challenge.salt !== "string"
                    || typeof challenge.challengeId !== "string"
                    || typeof challenge.nonce !== "string") {
                    throw new Error("O desafio de autenticação recebido do servidor está inválido.");
                }
                const salt = base64ToBytes(challenge.salt);
                if (salt.length !== 16) {
                    throw new Error("O servidor enviou um sal de senha inválido.");
                }
                const passwordHash = await hashUserPassword(password, salt);
                const keyBytes = new Uint8Array(passwordHash.match(/.{2}/g).map(value => parseInt(value, 16)));
                const key = await crypto.subtle.importKey(
                    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
                const message = new TextEncoder().encode([
                    "CRAS-Desktop user authentication v1",
                    user.id,
                    challenge.challengeId,
                    challenge.nonce
                ].join("\n"));
                const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
                const proof = Array.from(signature, byte => byte.toString(16).padStart(2, "0")).join("");
                const authenticationResponse = await fetchPeer(`${endpoint}/api/user/authenticate`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        userId: user.id,
                        challengeId: challenge.challengeId,
                        proof
                    })
                }, 8000);
                const authentication = await readAuthResponse(authenticationResponse);
                if (!authenticationResponse.ok || authentication.authenticated !== true) {
                    throw new Error(authentication.error || "A senha informada não foi validada pelo servidor.");
                }
                return { salt: challenge.salt, hash: passwordHash };
            }

            async function loginSelectedUser(event) {
                event.preventDefault();
                const enteredName = document.getElementById("login-user").value.trim();
                const selectedRole = document.getElementById("login-role").value;
                const selectedUser = users.find(user =>
                    user.name.toLocaleLowerCase("pt-BR") === enteredName.toLocaleLowerCase("pt-BR")
                    && user.role === selectedRole);
                const status = document.getElementById("user-login-status");
                if (!selectedUser) {
                    status.textContent = "Nome e função não correspondem a um usuário cadastrado. Procure adm.dev.";
                    return;
                }
                const passwordInput = document.getElementById("login-password");
                const password = passwordInput.value;
                let passwordCreated = false;
                let credentialRestored = false;
                if (loginServerPasswordMode) {
                    let credential;
                    try {
                        credential = await authenticateUserWithServer(selectedUser, password);
                    } catch (error) {
                        status.textContent = error.message;
                        passwordInput.select();
                        return;
                    }
                    const updatedUsers = users.map(user => user.id === selectedUser.id
                        ? { ...user, passwordCredential: credential }
                        : user);
                    if (!await saveStorage(STORAGE_USERS, updatedUsers)) {
                        status.textContent = "Não foi possível salvar a senha do servidor neste dispositivo.";
                        return;
                    }
                    users = updatedUsers;
                    credentialRestored = true;
                } else if (selectedUser.passwordCredential) {
                    const calculatedHash = await hashUserPassword(
                        password, base64ToBytes(selectedUser.passwordCredential.salt)
                    );
                    if (calculatedHash !== selectedUser.passwordCredential.hash) {
                        status.textContent = "Senha incorreta. Se já tem senha no servidor, escolha essa opção.";
                        passwordInput.select();
                        return;
                    }
                } else {
                    const confirmation = document.getElementById("login-password-confirm").value;
                    if (password.length < 8 || password.length > 128) {
                        status.textContent = "Crie uma senha com pelo menos 8 caracteres.";
                        passwordInput.focus();
                        return;
                    }
                    if (password !== confirmation) {
                        status.textContent = "As senhas não coincidem.";
                        document.getElementById("login-password-confirm").select();
                        return;
                    }
                    const credential = await createUserPasswordCredential(password);
                    const updatedUsers = users.map(user => user.id === selectedUser.id
                        ? { ...user, passwordCredential: credential }
                        : user);
                    if (!await saveStorage(STORAGE_USERS, updatedUsers)) {
                        status.textContent = "Não foi possível salvar sua senha neste dispositivo.";
                        return;
                    }
                    users = updatedUsers;
                    passwordCreated = true;
                }
                const authenticatedUser = users.find(user => user.id === selectedUser.id);
                if (!await activateUser(authenticatedUser, true)) return;
                if (passwordCreated || credentialRestored) schedulePeerSync(authenticatedUser.role);
            }

            async function restoreLocalUser() {
                const rememberSetting = await database.settings.get(STORAGE_REMEMBER_USER_SESSION);
                const rememberUserSession = rememberSetting?.value === true;
                document.getElementById("remember-user-session").checked = rememberUserSession;
                const savedUser = await database.settings.get(STORAGE_LOCAL_ACTIVE_USER);
                if (!rememberUserSession) await database.settings.delete(STORAGE_LOCAL_ACTIVE_USER);
                rememberedUserId = rememberUserSession && typeof savedUser?.value === "string"
                    ? savedUser.value
                    : "";
                const rememberedUser = users.find(user => user.id === rememberedUserId);
                if (rememberedUser?.passwordCredential) {
                    if (!await activateUser(rememberedUser)) showUserLogin(rememberedUserId);
                    return;
                }
                showUserLogin(rememberedUserId);
            }

            async function persistRememberUserSessionPreference(rememberUserSession) {
                await database.transaction("rw", database.settings, async () => {
                    await database.settings.put({
                        key: STORAGE_REMEMBER_USER_SESSION,
                        value: rememberUserSession
                    });
                    if (!rememberUserSession) await database.settings.delete(STORAGE_LOCAL_ACTIVE_USER);
                });
                if (!rememberUserSession) {
                    rememberedUserId = "";
                    document.getElementById("login-user").value = "";
                }
            }

            function getSyncBridgeUrl(endpoint = preferences.syncEndpoint) {
                if (!endpoint) return "";
                try {
                    const url = new URL(endpoint);
                    if (window.CRASDesktop) {
                        if (url.protocol !== "http:" || !isPrivateIPv4Address(url.hostname)
                            || url.username || url.password
                            || url.pathname !== "/" || url.search || url.hash) return "";
                        return url.origin;
                    }
                    if (url.protocol !== "https:" || url.hostname !== "script.google.com"
                        || !/^\/macros\/(?:u\/\d+\/)?s\/[^/]+(?:\/exec)?\/?$/.test(url.pathname)) return "";
                    url.pathname = url.pathname.replace(/^\/macros\/u\/\d+\/s\//, "/macros/s/");
                    if (!/\/exec\/?$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/, "")}/exec`;
                    url.searchParams.set("bridge", "1");
                    return url.href;
                } catch {
                    return "";
                }
            }

            function isPrivateIPv4Address(hostname) {
                const parts = hostname.split(".");
                if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return false;
                const octets = parts.map(Number);
                if (octets.some(part => part < 0 || part > 255)) return false;
                const [first, second] = octets;
                return first === 10
                    || first === 172 && second >= 16 && second <= 31
                    || first === 192 && second === 168;
            }

            function getGoogleAppsScriptBridgeUrl(endpoint = window.CRASDesktop
                ? preferences.googleSheetEndpoint
                : preferences.syncEndpoint) {
                if (!endpoint) return "";
                try {
                    const url = new URL(endpoint);
                    if (url.protocol !== "https:" || url.hostname !== "script.google.com"
                        || url.username || url.password
                        || !/^\/macros\/(?:u\/\d+\/)?s\/[^/]+(?:\/exec)?\/?$/.test(url.pathname)) return "";
                    url.pathname = url.pathname.replace(/^\/macros\/u\/\d+\/s\//, "/macros/s/");
                    if (!/\/exec\/?$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/, "")}/exec`;
                    url.searchParams.set("bridge", "1");
                    return url.href;
                } catch {
                    return "";
                }
            }

            function getConfiguredDesktopPeers() {
                const user = users.find(item => item.id === activeUser?.id);
                if (!window.CRASDesktop || desktopNodeInfo?.centralServer
                    || !centralServerDiscoveryCache || !user?.passwordCredential) return [];
                return [{
                    endpoint: centralServerDiscoveryCache.endpoint,
                    nodeId: centralServerDiscoveryCache.nodeId,
                    userId: user.id,
                    name: user.name,
                    role: user.role,
                    credential: user.passwordCredential
                }];
            }

            async function discoverCentralServer(force = false) {
                if (!window.CRASDesktop || desktopNodeInfo?.centralServer) return [];
                if (!force && centralServerDiscoveryCache
                    && Date.now() - centralServerDiscoveryTime < 15000) {
                    return getConfiguredDesktopPeers();
                }
                const response = await fetchPeer("/api/central-servers", { cache: "no-store" }, 12000);
                if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
                    throw new Error(
                        `O serviço local respondeu HTTP ${response.status} sem JSON. ` +
                        "Feche e reabra o CRAS Desktop e tente novamente."
                    );
                }
                const result = await response.json();
                if (!response.ok || !Array.isArray(result.servers)) {
                    throw new Error(result.error || "Não foi possível localizar o servidor central na rede.");
                }
                const servers = result.servers.filter(server => server
                    && typeof server.nodeId === "string"
                    && Array.isArray(server.endpoints)
                    && server.endpoints.some(endpoint => typeof endpoint === "string"));
                const uniqueServers = [...new Map(servers.map(server => [server.nodeId, server])).values()];
                if (uniqueServers.length > 1) {
                    centralServerDiscoveryCache = null;
                    throw new Error("Mais de um servidor central foi encontrado. Mantenha ativo somente o notebook servidor.");
                }
                if (!uniqueServers.length) {
                    centralServerDiscoveryCache = null;
                    centralServerDiscoveryTime = Date.now();
                    document.getElementById("central-server-discovery-status").textContent =
                        "Servidor central ainda não encontrado. Os dados permanecem salvos neste computador.";
                    return [];
                }
                const server = uniqueServers[0];
                const endpoint = server.endpoints.find(value => getSyncBridgeUrl(value));
                if (!endpoint) throw new Error("O servidor encontrado anunciou um endereço inválido.");
                centralServerDiscoveryCache = { nodeId: server.nodeId, endpoint };
                centralServerDiscoveryTime = Date.now();
                document.getElementById("central-server-discovery-status").textContent =
                    "Servidor central localizado automaticamente na rede.";
                return getConfiguredDesktopPeers();
            }

            async function registerUserWithServer(peer) {
                if (!peer?.userId || !peer.credential?.salt || !peer.credential?.hash) {
                    throw new Error("O usuário precisa cadastrar uma senha individual antes de sincronizar.");
                }
                const endpoint = mobileClient
                    ? location.origin
                    : getSyncBridgeUrl(peer.endpoint);
                const response = await fetchPeer(`${endpoint}/api/user/register`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        userId: peer.userId,
                        name: peer.name,
                        role: peer.role,
                        credential: peer.credential
                    })
                }, 5000);
                const result = await response.json();
                if (!response.ok) {
                    throw new Error(result.error || "Não foi possível cadastrar sua senha no servidor central.");
                }
            }

            async function configureAutomaticBackup(enabled) {
                if (!window.CRASDesktop) return;
                const response = await fetchPeer("/api/backup-config", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ isPrincipal: Boolean(enabled) })
                });
                const result = await response.json();
                if (!response.ok) {
                    throw new Error(result.error || "Não foi possível configurar os backups diários.");
                }
                return result;
            }

            async function refreshAutomaticBackupStatus() {
                if (!window.CRASDesktop) return;
                const statusElement = document.getElementById("principal-backup-status");
                try {
                    const response = await fetchPeer("/api/backup-status", { cache: "no-store" }, 5000);
                    const result = await response.json();
                    if (!response.ok) {
                        throw new Error(result.error || "Não foi possível consultar o último backup.");
                    }
                    latestAutomaticBackup = result;
                    if (!result.enabled) {
                        statusElement.textContent = "Backup diário desativado neste computador.";
                    } else if (!result.createdAt) {
                        statusElement.textContent = "Backup diário ativo, mas ainda não há uma cópia disponível.";
                    } else {
                        const createdAt = new Date(result.createdAt);
                        const formatted = new Intl.DateTimeFormat("pt-BR", {
                            dateStyle: "short",
                            timeStyle: "short"
                        }).format(createdAt);
                        const isStale = !Number.isFinite(createdAt.getTime())
                            || Date.now() - createdAt.getTime() > 36 * 60 * 60 * 1000;
                        statusElement.textContent = isStale
                            ? `Atenção: o último backup é de ${formatted}. Confira se o servidor ficou ligado.`
                            : `Último backup automático: ${formatted}.`;
                    }
                } catch (error) {
                    console.error("Não foi possível consultar o estado do backup automático.", error);
                    statusElement.textContent = `Não foi possível verificar o último backup: ${error.message}`;
                }
            }

            function configureSyncBridge() {
                if (offlineMode || !accessToken) {
                    syncBridgeFrame.hidden = true;
                    return;
                }
                const bridgeUrl = window.CRASDesktop
                    ? getGoogleAppsScriptBridgeUrl()
                    : getSyncBridgeUrl();
                if (!window.google?.script?.run && bridgeUrl && syncBridgeFrame.src !== bridgeUrl) {
                    syncBridgeReady = false;
                    syncBridgeTarget = null;
                    syncBridgeFrame.src = bridgeUrl;
                }
                syncBridgeFrame.hidden = !bridgeUrl || Boolean(window.google?.script?.run);
            }

            async function setupAccessGate() {
                const gate = document.getElementById("access-gate");
                const form = document.getElementById("access-gate-form");
                const tokenInput = document.getElementById("access-token");
                const endpointWrap = document.getElementById("access-endpoint-wrap");
                const endpointInput = document.getElementById("access-endpoint");
                const submitButton = document.getElementById("access-submit");
                const offlineButton = document.getElementById("access-offline");
                const status = document.getElementById("access-gate-status");

                endpointWrap.hidden = hostedAppsScript;
                endpointInput.required = !hostedAppsScript;
                offlineButton.hidden = hostedAppsScript;
                endpointInput.value = preferences.syncEndpoint || "";
                tokenInput.disabled = false;
                endpointInput.disabled = false;
                submitButton.disabled = false;
                offlineButton.disabled = hostedAppsScript;
                status.textContent = "";
                if (mobileClient) {
                    gate.hidden = false;
                    const mobileForm = document.getElementById("mobile-access-form");
                    const pinInput = document.getElementById("mobile-access-pin");
                    const mobileStatus = document.getElementById("mobile-access-status");
                    const mobileSubmit = document.getElementById("mobile-access-submit");
                    let info = null;
                    let offlineCredentialError = "";
                    mobileSubmit.disabled = true;
                    return new Promise(resolve => {
                        mobileForm.addEventListener("submit", async event => {
                            event.preventDefault();
                            const canUseServer = info?.enabled && info.ready;
                            const canUseOffline = Boolean(mobileOfflineCredentials.info?.enabled
                                && (mobileOfflineCredentials.proof || mobileOfflineCredentials.key))
                                && info?.enabled !== false;
                            if (!canUseServer && !canUseOffline) return;
                            mobileSubmit.disabled = true;
                            mobileStatus.textContent = mobileOfflineCredentials.key
                                ? "Validando o acesso salvo neste celular…"
                                : "Validando o código móvel…";
                            try {
                                let state = null;
                                if (canUseServer) {
                                    mobileAccessKey = mobileOfflineCredentials.key
                                        || await deriveMobileAccessKey(pinInput.value, info);
                                    try {
                                        state = await mobileRequest({ operation: "read" });
                                    } catch (error) {
                                        if ((error.status === 401 || error.status === 403)
                                            && mobileOfflineCredentials.key) {
                                            await clearMobileOfflineCredentials();
                                            mobileAccessKey = null;
                                            mobileStatus.textContent =
                                                "O código móvel mudou ou foi desativado. Informe o código atual para este celular.";
                                            throw error;
                                        }
                                        if (error.status === 401 || error.status === 403 || !canUseOffline) throw error;
                                        mobileStatus.textContent = "Servidor indisponível. Abrindo a cópia offline…";
                                    }
                                }
                                if (state) {
                                    if (!Array.isArray(state.snapshot?.appointments)
                                        || !Array.isArray(state.snapshot?.paaRecords)
                                        || !Number.isSafeInteger(state.revision)) {
                                        throw new Error("O computador retornou dados móveis inválidos.");
                                    }
                                    const localSnapshot = createSyncSnapshot();
                                    const mergedSnapshot = mergePeerSnapshots(
                                        mobileNodeBaseSnapshot,
                                        localSnapshot,
                                        state.snapshot,
                                        activeUser?.role,
                                        state.actorRole
                                    );
                                    await applySyncedSnapshot(
                                        mergedSnapshot,
                                        state.snapshot,
                                        [],
                                        false
                                    );
                                    await rememberMobileServerState(state.snapshot, state.revision);
                                    mobileOfflineMode = false;
                                    try {
                                        mobileOfflineCredentials = await saveMobileOfflineCredentials(info, mobileAccessKey);
                                    } catch (error) {
                                        console.error("Não foi possível preparar o acesso offline neste celular.", error);
                                        void clearMobileOfflineCredentials();
                                        offlineCredentialError =
                                            "Não foi possível salvar o acesso neste navegador. O código será solicitado novamente na próxima abertura.";
                                    }
                                    mobilePendingSync = !syncValuesEqual(mergedSnapshot, state.snapshot);
                                    updateSyncIndicator();
                                } else {
                                    mobileAccessKey = mobileOfflineCredentials.key
                                        || await verifyMobileOfflineCredentials(
                                            pinInput.value,
                                            mobileOfflineCredentials.info,
                                            mobileOfflineCredentials.proof
                                        );
                                    mobileOfflineMode = true;
                                    const localSnapshot = createSyncSnapshot();
                                    if (!Array.isArray(localSnapshot.appointments)
                                        || !Array.isArray(localSnapshot.paaRecords)) {
                                        throw new Error("Não há uma cópia local válida neste celular.");
                                    }
                                }
                                document.documentElement.classList.add("mobile-authenticated");
                                gate.hidden = true;
                                document.querySelector(".offline").textContent = mobileOfflineMode
                                    ? "Modo offline · dados salvos neste celular"
                                    : "Conectado ao servidor CRAS";
                                if (mobileOfflineMode) {
                                    showSyncStatus("Modo offline: as alterações ficam neste celular e serão sincronizadas quando o servidor voltar.", 0);
                                } else if (offlineCredentialError) {
                                    showSyncStatus(`Conectado, mas não foi possível preparar o modo offline: ${offlineCredentialError}`, 0);
                                } else if (window.CRASServiceWorkerError) {
                                    showSyncStatus("Conectado. O cache offline do aplicativo não foi instalado neste navegador.", 0);
                                }
                                resolve();
                            } catch (error) {
                                mobileAccessKey = null;
                                mobileStatus.textContent = error.message || "Não foi possível abrir o sistema.";
                            } finally {
                                mobileSubmit.disabled = !(info?.enabled && info.ready)
                                    && !(mobileOfflineCredentials.info?.enabled
                                        && (mobileOfflineCredentials.proof || mobileOfflineCredentials.key)
                                        && info?.enabled !== false);
                                pinInput.value = "";
                                if (!gate.hidden) pinInput.focus();
                            }
                        });
                        Promise.all([
                            readMobileOfflineCredentials(),
                            database.settings.get(STORAGE_MOBILE_NODE_REVISION),
                            database.settings.get(STORAGE_MOBILE_NODE_BASE_SNAPSHOT)
                        ]).then(async ([credentials, revisionEntry, baseEntry]) => {
                            mobileOfflineCredentials = credentials;
                            mobileNodeRevision = Number(revisionEntry?.value) || 0;
                            mobileNodeBaseSnapshot = baseEntry?.value || null;
                            try {
                                const response = await fetchPeer("/api/mobile-info", { cache: "no-store" }, 5000);
                                if (!response.ok) throw new Error("Não foi possível consultar o servidor CRAS.");
                                info = await response.json();
                                mobileServerVersion = typeof info.appVersion === "string" ? info.appVersion : "";
                            } catch (error) {
                                console.error("Servidor móvel indisponível; verificando a cópia offline.", error);
                            }
                            if (info?.enabled === false) {
                                await clearMobileOfflineCredentials();
                            }
                            const canUseOffline = Boolean(mobileOfflineCredentials.info?.enabled
                                && (mobileOfflineCredentials.proof || mobileOfflineCredentials.key))
                                && info?.enabled !== false;
                            mobileSubmit.disabled = !(info?.enabled && info.ready) && !canUseOffline;
                            mobileStatus.textContent = info?.enabled === false
                                ? "O Admin desativou o acesso móvel."
                                : info?.ready
                                    ? "Conecte-se ao servidor ou use a cópia offline deste dispositivo."
                                    : canUseOffline
                                        ? "Servidor indisponível. Entre com o código móvel para abrir a cópia offline."
                                        : !info
                                            ? "Não foi possível alcançar o servidor. Confirme que o CRAS está aberto e que o celular está na mesma rede; depois, escaneie o QR atualizado."
                                            : "O servidor ainda está inicializando. Tente novamente em instantes.";
                            if (window.CRASServiceWorkerError) {
                                mobileStatus.textContent += " O cache offline do aplicativo não foi instalado.";
                            }
                            if (mobileOfflineCredentials.key) {
                                mobileStatus.textContent = "Acesso reconhecido neste celular; conectando…";
                                mobileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
                            } else {
                                pinInput.focus();
                            }
                        }).catch(error => {
                            mobileStatus.textContent = `Não foi possível carregar o acesso móvel: ${error.message}`;
                        });
                    });
                }
                if (window.CRASDesktop) {
                    try {
                        const response = await fetch("/api/info?details=1", { cache: "no-store" });
                        if (!response.ok) throw new Error("O serviço local não respondeu corretamente.");
                        desktopNodeInfo = await response.json();
                        if (!desktopNodeInfo.nodeId) throw new Error("Não foi possível carregar a identificação deste computador.");
                        updateServerTransferControls();
                        document.getElementById("central-server-toggle").checked =
                            desktopNodeInfo.centralServer === true;
                        if (hadLegacyDesktopServerSettings) {
                            if (!await saveStorage(STORAGE_PREFERENCES, preferences)) {
                                throw new Error("Não foi possível remover as antigas configurações de IP e código salvas neste computador.");
                            }
                        }
                        void configureAutomaticBackup(preferences.isPrincipalComputer)
                            .then(() => refreshAutomaticBackupStatus())
                            .catch(error => {
                                console.error("Não foi possível sincronizar a configuração do backup automático.", error);
                                document.getElementById("principal-backup-status").textContent =
                                    `Não foi possível configurar o backup automático: ${error.message}`;
                            });
                        document.getElementById("central-server-discovery-status").textContent =
                            desktopNodeInfo.centralServer
                                ? "Este computador está configurado como servidor central."
                                : "Localizando automaticamente o servidor central na rede.";
                        const serviceHost = desktopNodeInfo.mobileAddresses?.[0]
                            || desktopNodeInfo.hostname
                            || "";
                        document.getElementById("sync-mobile-addresses").value =
                            desktopNodeInfo.centralServer && desktopNodeInfo.mobileHttpsReady
                                ? `https://${serviceHost}:${desktopNodeInfo.mobilePort || 8766}`
                                : "Ative o servidor central neste notebook para habilitar o acesso móvel automático";
                        document.getElementById("sync-mobile-ca").value = desktopNodeInfo.centralServer
                            ? `http://${serviceHost}:${desktopNodeInfo.port}/api/mobile-ca`
                            : "Disponível após ativar o servidor central";
                        document.getElementById("sync-mobile-fingerprint").value =
                            desktopNodeInfo.mobileCaFingerprint || "Certificado HTTPS não configurado";

                        const mobileBadge = document.getElementById("mobile-server-badge");
                        if (mobileBadge) {
                            if (desktopNodeInfo.mobileHttpsReady) {
                                mobileBadge.textContent = `🟢 Ativo (Porta ${desktopNodeInfo.mobilePort || 8766})`;
                                mobileBadge.className = "badge-status-pill badge-online";
                            } else {
                                mobileBadge.textContent = "🔴 Desativado";
                                mobileBadge.className = "badge-status-pill badge-offline";
                            }
                        }

                        const qrContainer = document.getElementById("qr-code-container");
                        const qrImg = document.getElementById("mobile-qr-image");
                        if (qrContainer && qrImg && serviceHost
                            && desktopNodeInfo.centralServer && desktopNodeInfo.mobileHttpsReady) {
                            qrImg.src = `/api/qr?text=${encodeURIComponent(
                                `https://${serviceHost}:${desktopNodeInfo.mobilePort || 8766}/`
                            )}`;
                            qrContainer.hidden = false;
                        } else if (qrContainer) {
                            qrContainer.hidden = true;
                        }
                        const caQrContainer = document.getElementById("mobile-ca-qr-container");
                        const caQrImg = document.getElementById("mobile-ca-qr-image");
                        if (caQrContainer && caQrImg && serviceHost
                            && desktopNodeInfo.centralServer && desktopNodeInfo.mobileCaFingerprint) {
                            caQrImg.src = `/api/qr?text=${encodeURIComponent(`http://${serviceHost}:${desktopNodeInfo.port}/api/mobile-ca`)}`;
                            caQrContainer.hidden = false;
                        } else if (caQrContainer) {
                            caQrContainer.hidden = true;
                        }

                        document.querySelector(".offline").textContent = "Dados locais · sincronização com servidor";
                        gate.hidden = true;
                        showSyncStatus(desktopNodeInfo.centralServer
                            ? "Servidor central pronto; outros computadores o localizarão automaticamente."
                            : "Aplicativo pronto. O servidor central será localizado automaticamente na rede.", 0);
                        if (!desktopNodeInfo.centralServer) {
                            void discoverCentralServer(true).catch(error => {
                                console.error("Não foi possível localizar o servidor central.", error);
                                document.getElementById("central-server-discovery-status").textContent =
                                    `A descoberta automática falhou: ${error.message}`;
                            });
                        }
                    } catch (error) {
                        console.error("Não foi possível inicializar o armazenamento local do CRAS Desktop.", error);
                        offlineMode = true;
                        gate.hidden = true;
                        window.alert(`A interface continuará disponível apenas neste computador. Não foi possível inicializar o armazenamento local: ${error.message}`);
                    }
                    return;
                }
                tokenInput.focus();

                return new Promise(resolve => {
                    offlineButton.addEventListener("click", () => {
                        offlineMode = true;
                        accessToken = "";
                        document.querySelector(".offline").textContent = "Modo offline ativo";
                        gate.hidden = true;
                        showSyncStatus("Modo offline: os dados serão salvos neste dispositivo e não serão sincronizados com o Google.", 0);
                        resolve();
                    });

                    form.addEventListener("submit", async event => {
                        event.preventDefault();
                        status.textContent = "Conectando ao Apps Script para validar o token…";
                        submitButton.disabled = true;
                        tokenInput.disabled = true;
                        endpointInput.disabled = true;

                        try {
                            if (!hostedAppsScript) {
                                const endpoint = endpointInput.value.trim();
                                if (!getSyncBridgeUrl(endpoint)) {
                                    throw new Error("Informe o URL completo da implantação publicada do Apps Script (…/s/ID/exec).");
                                }
                                if (preferences.syncEndpoint !== endpoint) {
                                    await updatePreferences({ syncEndpoint: endpoint });
                                    if (preferences.syncEndpoint !== endpoint) {
                                        throw new Error("Não foi possível salvar o URL do Apps Script neste dispositivo.");
                                    }
                                }
                            }

                            accessToken = tokenInput.value.trim();
                            configureSyncBridge();
                            const authorized = await callSyncBackend("validateStartupToken");
                            if (authorized !== true) {
                                accessToken = "";
                                throw new Error("Token incorreto. Tente novamente.");
                            }
                            document.querySelector(".offline").textContent = "Conectado ao Apps Script";
                            gate.hidden = true;
                            resolve();
                        } catch (error) {
                            accessToken = "";
                            status.textContent = error.message || "Não foi possível validar o token.";
                        } finally {
                            submitButton.disabled = false;
                            tokenInput.disabled = false;
                            endpointInput.disabled = false;
                            if (!gate.hidden) tokenInput.focus();
                        }
                    });
                });
            }

            async function derivePeerKey(passphrase, salt) {
                const material = await crypto.subtle.importKey(
                    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]
                );
                return crypto.subtle.deriveKey(
                    { name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" },
                    material,
                    { name: "AES-GCM", length: 256 },
                    false,
                    ["encrypt", "decrypt"]
                );
            }

            function bytesToBase64(bytes) {
                let binary = "";
                bytes.forEach(byte => { binary += String.fromCharCode(byte); });
                return btoa(binary);
            }

            function base64ToBytes(value) {
                return Uint8Array.from(atob(value), character => character.charCodeAt(0));
            }

            function validateTechnicalCiphertextEnvelope(value) {
                if (!value || value.version !== 1 || typeof value.nonce !== "string"
                    || typeof value.ciphertext !== "string") {
                    throw new Error("O pacote de anotações técnicas criptografadas está inválido.");
                }
                const nonce = base64ToBytes(value.nonce);
                const ciphertext = base64ToBytes(value.ciphertext);
                if (nonce.length !== 12 || ciphertext.length < 16 || ciphertext.length > 40000) {
                    throw new Error("O pacote de anotações técnicas criptografadas está inválido.");
                }
            }

            async function importTechnicalKey(value) {
                const rawKey = base64ToBytes(value);
                if (rawKey.length !== 32) {
                    throw new Error("A chave técnica deve conter exatamente 32 bytes em Base64.");
                }
                return crypto.subtle.importKey(
                    "raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]
                );
            }

            async function encryptTechnicalValue(value, key, context) {
                const nonce = crypto.getRandomValues(new Uint8Array(12));
                const plaintext = new TextEncoder().encode(JSON.stringify(value));
                const ciphertext = await crypto.subtle.encrypt({
                    name: "AES-GCM",
                    iv: nonce,
                    additionalData: new TextEncoder().encode(`cras-technical-e2ee-v1:${context}`)
                }, key, plaintext);
                return {
                    version: 1,
                    nonce: bytesToBase64(nonce),
                    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
                };
            }

            async function decryptTechnicalValue(envelope, key, context) {
                if (!envelope || envelope.version !== 1) {
                    throw new Error("As anotações técnicas criptografadas têm formato inválido.");
                }
                const plaintext = await crypto.subtle.decrypt({
                    name: "AES-GCM",
                    iv: base64ToBytes(envelope.nonce),
                    additionalData: new TextEncoder().encode(`cras-technical-e2ee-v1:${context}`)
                }, key, base64ToBytes(envelope.ciphertext));
                return JSON.parse(new TextDecoder().decode(plaintext));
            }

            async function requestTechnicalKey() {
                if (!window.crypto?.subtle) {
                    throw new Error("Este dispositivo não oferece a criptografia necessária para abrir os registros técnicos.");
                }
                const config = storageCache.get(STORAGE_TECHNICAL_E2EE);
                const overlay = document.getElementById("technical-key-overlay");
                const form = document.getElementById("technical-key-form");
                const input = document.getElementById("technical-key-input");
                const generateButton = document.getElementById("technical-key-generate");
                const generatedWrap = document.getElementById("technical-key-generated-wrap");
                const generatedOutput = document.getElementById("technical-key-generated");
                const generatedHint = document.getElementById("technical-key-generated-hint");
                const confirmWrap = document.getElementById("technical-key-confirm-wrap");
                const confirmInput = document.getElementById("technical-key-confirm");
                const status = document.getElementById("technical-key-status");
                const submitButton = document.getElementById("technical-key-submit");
                const cancelButton = document.getElementById("technical-key-cancel");
                const copyButton = document.getElementById("technical-key-copy");
                generateButton.hidden = Boolean(config);
                generatedWrap.hidden = true;
                generatedHint.hidden = true;
                confirmWrap.hidden = Boolean(config);
                confirmInput.checked = false;
                input.value = "";
                status.textContent = config
                    ? "Informe a chave offline fornecida pela Técnica responsável."
                    : "Gere a chave inicial e guarde-a offline antes de continuar.";
                overlay.hidden = false;
                input.focus();
                return new Promise(resolve => {
                    let generated = false;
                    let finished = false;
                    const finish = result => {
                        if (finished) return;
                        finished = true;
                        form.removeEventListener("submit", onSubmit);
                        generateButton.removeEventListener("click", onGenerate);
                        cancelButton.removeEventListener("click", onCancel);
                        copyButton.removeEventListener("click", onCopy);
                        overlay.hidden = true;
                        input.value = "";
                        generatedOutput.value = "";
                        resolve(result);
                    };
                    const onGenerate = () => {
                        const bytes = crypto.getRandomValues(new Uint8Array(32));
                        const secret = bytesToBase64(bytes);
                        input.value = secret;
                        generatedOutput.value = secret;
                        generatedWrap.hidden = false;
                        generatedHint.hidden = false;
                        confirmWrap.hidden = false;
                        generated = true;
                        status.textContent = "Copie e guarde a chave em local protegido. Não a envie por mensagem ou e-mail.";
                    };
                    const onCopy = async () => {
                        generatedOutput.select();
                        try {
                            await navigator.clipboard.writeText(generatedOutput.value);
                            status.textContent = "Chave copiada. Guarde-a offline e limpe a área de transferência depois.";
                        } catch (error) {
                            status.textContent = "Não foi possível copiar automaticamente. Selecione a chave e copie-a manualmente.";
                        }
                    };
                    const onCancel = () => finish(null);
                    const onSubmit = async event => {
                        event.preventDefault();
                        submitButton.disabled = true;
                        status.textContent = "Validando a chave…";
                        try {
                            const key = await importTechnicalKey(input.value.trim());
                            if (config) {
                                const check = await decryptTechnicalValue(config.keyCheck, key, "key-check");
                                if (check !== "CRAS technical annotation key check v1") {
                                    throw new Error("A chave informada não corresponde aos registros técnicos.");
                                }
                                finish({ key, config });
                                return;
                            }
                            if (!generated || !confirmInput.checked) {
                                throw new Error("Gere uma chave e confirme que a guardou offline antes de continuar.");
                            }
                            const keyCheck = await encryptTechnicalValue(
                                "CRAS technical annotation key check v1", key, "key-check"
                            );
                            finish({ key, config: { version: 1, keyCheck } });
                        } catch (error) {
                            status.textContent = error.message || "Não foi possível validar a chave.";
                        } finally {
                            submitButton.disabled = false;
                        }
                    };
                    form.addEventListener("submit", onSubmit);
                    generateButton.addEventListener("click", onGenerate);
                    cancelButton.addEventListener("click", onCancel);
                    copyButton.addEventListener("click", onCopy);
                });
            }

            async function deriveMobileAccessKey(password, info) {
                const material = await crypto.subtle.importKey(
                    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]
                );
                return crypto.subtle.deriveKey(
                    {
                        name: "PBKDF2",
                        salt: base64ToBytes(info.salt),
                        iterations: info.iterations,
                        hash: "SHA-256"
                    },
                    material,
                    { name: "AES-GCM", length: 256 },
                    false,
                    ["encrypt", "decrypt"]
                );
            }

            async function encryptMobilePayload(payload, key) {
                const nonce = crypto.getRandomValues(new Uint8Array(12));
                const ciphertext = await crypto.subtle.encrypt(
                    { name: "AES-GCM", iv: nonce },
                    key,
                    new TextEncoder().encode(JSON.stringify(payload))
                );
                return {
                    nonce: bytesToBase64(nonce),
                    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
                };
            }

            async function mobileRequest(payload) {
                if (!mobileAccessKey) throw new Error("O acesso móvel expirou. Digite o código novamente.");
                const requestPayload = mobileServerVersion
                    ? { ...payload, clientVersion: mobileServerVersion }
                    : payload;
                const envelope = await encryptMobilePayload(requestPayload, mobileAccessKey);
                const response = await fetchPeer("/api/mobile-snapshot", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(envelope)
                });
                const result = await response.json();
                if (!response.ok) {
                    const error = new Error(result.error || "Não foi possível acessar os dados do computador.");
                    error.status = response.status;
                    error.revision = result.revision;
                    throw error;
                }
                const plaintext = await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: base64ToBytes(result.nonce) },
                    mobileAccessKey,
                    base64ToBytes(result.ciphertext)
                );
                const resultPayload = JSON.parse(new TextDecoder().decode(plaintext));
                if (typeof resultPayload.appVersion === "string") {
                    mobileServerVersion = resultPayload.appVersion;
                }
                return resultPayload;
            }

            async function saveMobileOfflineCredentials(info, key) {
                const proof = await encryptMobilePayload(
                    { proof: "cras-mobile-offline-v1" },
                    key
                );
                await database.settings.bulkPut([
                    { key: STORAGE_MOBILE_ACCESS_INFO, value: info },
                    { key: STORAGE_MOBILE_ACCESS_PROOF, value: proof },
                    { key: STORAGE_MOBILE_ACCESS_KEY, value: key }
                ]);
                return { info, proof, key };
            }

            async function readMobileOfflineCredentials() {
                const [infoEntry, proofEntry, keyEntry] = await Promise.all([
                    database.settings.get(STORAGE_MOBILE_ACCESS_INFO),
                    database.settings.get(STORAGE_MOBILE_ACCESS_PROOF),
                    database.settings.get(STORAGE_MOBILE_ACCESS_KEY)
                ]);
                return {
                    info: infoEntry?.value || null,
                    proof: proofEntry?.value || null,
                    key: keyEntry?.value || null
                };
            }

            async function verifyMobileOfflineCredentials(pin, info, proof) {
                if (!info?.salt || !Number.isSafeInteger(info.iterations) || !proof?.nonce || !proof?.ciphertext) {
                    throw new Error("Este celular ainda não tem acesso offline. Conecte-o ao servidor e entre uma vez.");
                }
                const key = await deriveMobileAccessKey(pin, info);
                try {
                    const plaintext = await crypto.subtle.decrypt(
                        { name: "AES-GCM", iv: base64ToBytes(proof.nonce) },
                        key,
                        base64ToBytes(proof.ciphertext)
                    );
                    const result = JSON.parse(new TextDecoder().decode(plaintext));
                    if (result.proof !== "cras-mobile-offline-v1") throw new Error("Código inválido.");
                    return key;
                } catch {
                    throw new Error("Código móvel incorreto para este dispositivo offline.");
                }
            }

            async function rememberMobileServerState(snapshot, revision) {
                if (!Number.isSafeInteger(revision) || revision < 0) {
                    throw new Error("O servidor retornou uma revisão móvel inválida.");
                }
                await database.settings.bulkPut([
                    { key: STORAGE_MOBILE_NODE_REVISION, value: revision },
                    { key: STORAGE_MOBILE_NODE_BASE_SNAPSHOT, value: snapshot }
                ]);
                mobileNodeRevision = revision;
                mobileNodeBaseSnapshot = snapshot;
            }

            async function clearMobileOfflineCredentials() {
                try {
                    await database.settings.bulkDelete([
                        STORAGE_MOBILE_ACCESS_INFO,
                        STORAGE_MOBILE_ACCESS_PROOF,
                        STORAGE_MOBILE_ACCESS_KEY
                    ]);
                    mobileOfflineCredentials = { info: null, proof: null, key: null };
                } catch (error) {
                    console.error("Não foi possível remover as credenciais móveis locais.", error);
                    showSyncStatus("Não foi possível remover as credenciais móveis deste dispositivo.", 0);
                }
            }

            async function fetchPeerInfo(endpoint = getSyncBridgeUrl()) {
                const response = await fetchPeer(`${endpoint}/api/info`, { cache: "no-store" });
                if (!response.ok) throw new Error("Não foi possível localizar o servidor central na rede.");
                const info = await response.json();
                if (!info.nodeId || info.nodeId === desktopNodeInfo?.nodeId || info.centralServer !== true) {
                    throw new Error("O computador encontrado não está configurado como servidor central.");
                }
                if (!info.ready) throw new Error("O servidor central ainda está inicializando. Tente novamente em instantes.");
                return info;
            }

            async function fetchPeer(url, options = {}, timeoutMs = appConfig.sync.timeoutMs) {
                const controller = new AbortController();
                const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
                try {
                    return await fetch(url, { ...options, signal: controller.signal });
                } catch (error) {
                    if (error.name === "AbortError") throw new Error(`A conexão excedeu o tempo limite de ${Math.ceil(timeoutMs / 1000)} segundos.`);
                    throw error;
                } finally {
                    window.clearTimeout(timeout);
                }
            }

            async function persistLocalSnapshotToServer(snapshot, actorRole = activeUser?.role) {
                let candidate = snapshot;
                for (let attempt = 0; attempt < 4; attempt += 1) {
                    const response = await fetchPeer("/api/local-snapshot", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            snapshot: candidate,
                            expectedRevision: localNodeRevision,
                            actorRole
                        })
                    });
                    const result = await response.json();
                    if (response.status === 409) {
                        await refreshLocalNodeFromServer(true, false);
                        candidate = createSyncSnapshot();
                        continue;
                    }
                    if (!response.ok) throw new Error(result.error || "Não foi possível atualizar o estado local.");
                    await rememberLocalNodeState(candidate, result.revision);
                    if (desktopNodeInfo) desktopNodeInfo.ready = true;
                    return;
                }
                throw new Error("O estado local mudou repetidamente. Tente sincronizar novamente.");
            }

            async function persistAcceptedPeerSnapshot(peerId, peerBase, actorRole = activeUser?.role) {
                for (let attempt = 0; attempt < 4; attempt += 1) {
                    const candidate = createSyncSnapshot();
                    const response = await fetchPeer("/api/accept-sync", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            peerId,
                            peerBase,
                            snapshot: candidate,
                            expectedRevision: localNodeRevision,
                            actorRole
                        })
                    });
                    const result = await response.json();
                    if (response.status === 409) {
                        await refreshLocalNodeFromServer(true, false);
                        continue;
                    }
                    if (!response.ok) {
                        throw new Error(result.error || "Não foi possível registrar o par sincronizado neste computador.");
                    }
                    await rememberLocalNodeState(candidate, result.revision);
                    return;
                }
                throw new Error("O estado mudou repetidamente durante a sincronização. Tente novamente.");
            }

            async function rememberLocalNodeState(snapshot, revision) {
                const nextRevision = Number(revision);
                if (!Number.isSafeInteger(nextRevision) || nextRevision < 0) {
                    throw new Error("O servidor local retornou uma revisão inválida.");
                }
                await database.transaction("rw", database.settings, async () => {
                    await database.settings.bulkPut([
                        { key: STORAGE_LOCAL_NODE_REVISION, value: nextRevision },
                        { key: STORAGE_LOCAL_NODE_BASE_SNAPSHOT, value: snapshot }
                    ]);
                });
                storageCache.set(STORAGE_LOCAL_NODE_REVISION, nextRevision);
                storageCache.set(STORAGE_LOCAL_NODE_BASE_SNAPSHOT, snapshot);
                localNodeRevision = nextRevision;
                localNodeBaseSnapshot = snapshot;
            }

            async function rememberPeerSettings(peerSettings) {
                if (!peerSettings || typeof peerSettings !== "object" || Array.isArray(peerSettings)) return;
                const nextBases = {};
                Object.entries(peerSettings).forEach(([peerId, settings]) => {
                    if (settings && typeof settings === "object" && !Array.isArray(settings)) {
                        nextBases[peerId] = { settings };
                    }
                });
                await database.settings.put({ key: STORAGE_PEER_SYNC_BASES, value: nextBases });
                storageCache.set(STORAGE_PEER_SYNC_BASES, nextBases);
                peerSyncBaseSnapshots = nextBases;
                if (activePeerId && nextBases[activePeerId]) syncBaseSnapshot = nextBases[activePeerId];
            }

            function scheduleLocalSnapshotPersist(actorRole = activeUser?.role) {
                if (mobileClient) {
                    if (!mobileAccessKey) return;
                    if (mobileOfflineMode || !navigator.onLine) {
                        mobileOfflineMode = true;
                        mobilePendingSync = true;
                        document.querySelector(".offline").textContent = "Modo offline · alterações salvas neste celular";
                        updateSyncIndicator();
                        return;
                    }
                } else if (!window.CRASDesktop || !desktopNodeInfo?.nodeId) {
                    return;
                }
                window.clearTimeout(localSnapshotPersistTimer);
                localSnapshotPersistTimer = window.setTimeout(async () => {
                    if (syncInProgress) {
                        scheduleLocalSnapshotPersist(actorRole);
                        return;
                    }
                    try {
                        if (mobileClient) {
                            await persistMobileSnapshotToServer(createSyncSnapshot(), actorRole);
                            return;
                        }
                        await refreshLocalNodeFromServer(true);
                        await persistLocalSnapshotToServer(createSyncSnapshot(), actorRole);
                    } catch (error) {
                        if (mobileClient) {
                            mobileOfflineMode = true;
                            mobilePendingSync = true;
                            document.querySelector(".offline").textContent = "Modo offline · alterações salvas neste celular";
                            updateSyncIndicator();
                            console.error("Não foi possível enviar os dados móveis ao servidor.", error);
                            showSyncStatus("Os dados continuam salvos neste celular e serão sincronizados quando o servidor estiver disponível.", 0);
                        } else {
                            console.error("Não foi possível atualizar o estado local deste computador.", error);
                            showSyncStatus(`Os dados continuam salvos localmente; o servidor central será atualizado quando estiver disponível: ${error.message}`, 0);
                        }
                    }
                }, 400);
            }

            function schedulePeerSync(actorRole = activeUser?.role) {
                if (offlineMode || mobileClient) return;
                window.clearTimeout(syncChangeTimer);
                queuedSyncRole = actorRole || queuedSyncRole || null;
                syncChangeTimer = window.setTimeout(() => {
                    if (syncInProgress) {
                        syncRequestedAfterCurrent = true;
                        return;
                    }
                    const role = queuedSyncRole;
                    queuedSyncRole = null;
                    void syncWithGoogle(false, role);
                }, 650);
            }

            function scheduleSyncAfterActivation() {
                window.clearTimeout(activationSyncTimer);
                activationSyncTimer = window.setTimeout(() => {
                    if (document.visibilityState !== "visible" || !navigator.onLine || offlineMode) return;
                    if (mobileClient) {
                        if (mobileOfflineMode) return;
                        if (mobilePendingSync) scheduleLocalSnapshotPersist(activeUser?.role);
                        void refreshMobileSnapshotFromServer();
                        return;
                    }
                    void syncWithGoogle();
                }, 300);
            }

            async function refreshLocalNodeFromServer(force = false, persistMerged = true) {
                if (!window.CRASDesktop || !desktopNodeInfo?.nodeId || syncInProgress && !force) return;
                while (force && localNodeRefreshInProgress) {
                    await new Promise(resolve => window.setTimeout(resolve, 25));
                }
                if (localNodeRefreshInProgress) return;
                localNodeRefreshInProgress = true;
                try {
                    const infoResponse = await fetchPeer("/api/info", { cache: "no-store" });
                    if (!infoResponse.ok) throw new Error("Não foi possível consultar o estado local.");
                    const info = await infoResponse.json();
                    if (!force && Number(info.revision) <= localNodeRevision) return;
                    const stateResponse = await fetchPeer("/api/local-snapshot", { cache: "no-store" });
                    if (!stateResponse.ok) throw new Error("Não foi possível carregar o estado local sincronizado.");
                    const state = await stateResponse.json();
                    const currentSnapshot = createSyncSnapshot();
                    const snapshotToApply = mergePeerSnapshots(
                        localNodeBaseSnapshot, currentSnapshot, state.snapshot,
                        activeUser?.role, state.actorRole
                    );
                    await applySyncedSnapshot(snapshotToApply, state.snapshot, [], false);
                    await rememberPeerSettings(state.peerSettings);
                    await rememberLocalNodeState(state.snapshot, state.revision);
                    if (persistMerged && !syncValuesEqual(snapshotToApply, state.snapshot)) {
                        await persistLocalSnapshotToServer(snapshotToApply, activeUser?.role);
                    }
                } catch (error) {
                    console.error("Não foi possível atualizar o estado local sincronizado.", error);
                    showSyncStatus(`Há dados locais que não puderam ser carregados: ${error.message}`, 10000);
                    if (force) throw error;
                } finally {
                    localNodeRefreshInProgress = false;
                }
            }

            function callSyncBackend(method, ...args) {
                const allowedMethods = new Set([
                    "validateStartupToken",
                    "getCrASSyncSnapshot",
                    "syncCrASSnapshot",
                    "savePaaRecordToSheet",
                    "deletePaaRecordFromSheet"
                ]);
                if (!allowedMethods.has(method)) return Promise.reject(new Error("Operação de sincronização não autorizada."));
                if (window.CRASDesktop && method === "syncCrASSnapshot") {
                    const peerConfig = args.pop();
                    const endpoint = getSyncBridgeUrl(peerConfig?.endpoint);
                    const peerKey = peerConfig?.credential?.hash || "";
                    if (!endpoint || !peerConfig?.userId || !peerKey) {
                        return Promise.reject(new Error("Usuário sem credencial individual ou servidor central não encontrado."));
                    }
                    if (!desktopNodeInfo?.nodeId || !window.crypto?.subtle) {
                        return Promise.reject(new Error("A criptografia de sincronização não está disponível neste computador."));
                    }
                    return (async () => {
                        await registerUserWithServer(peerConfig);
                        const remoteInfo = peerConfig.info || await fetchPeerInfo(endpoint);
                        activePeerId = remoteInfo.nodeId;
                        syncBaseSnapshot = peerSyncBaseSnapshots[activePeerId] || null;
                        const salt = crypto.getRandomValues(new Uint8Array(16));
                        const nonce = crypto.getRandomValues(new Uint8Array(12));
                        const key = await derivePeerKey(peerKey, salt);
                        const payload = {
                            requestId: crypto.randomUUID(),
                            peerId: desktopNodeInfo.nodeId,
                            clientVersion: desktopNodeInfo.appVersion,
                            localSnapshot: args[1],
                            resolutions: args[2],
                            actorRole: args[3],
                            userId: peerConfig.userId
                        };
                        const cleartext = new TextEncoder().encode(JSON.stringify(payload));
                        const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
                            { name: "AES-GCM", iv: nonce }, key, cleartext
                        ));
                        const response = await fetchPeer(`${endpoint}/api/sync`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                userId: peerConfig.userId,
                                salt: bytesToBase64(salt),
                                nonce: bytesToBase64(nonce),
                                ciphertext: bytesToBase64(ciphertext)
                            })
                        });
                        const resultEnvelope = await response.json();
                        if (!response.ok) {
                            throw new Error(resultEnvelope.error || "O servidor central recusou a sincronização.");
                        }
                        const resultNonce = base64ToBytes(resultEnvelope.nonce);
                        const resultCiphertext = base64ToBytes(resultEnvelope.ciphertext);
                        const resultBytes = await crypto.subtle.decrypt(
                            { name: "AES-GCM", iv: resultNonce },
                            key,
                            resultCiphertext
                        );
                        return JSON.parse(new TextDecoder().decode(resultBytes));
                    })();
                }
                if (!accessToken) return Promise.reject(new Error("Informe o token para acessar o sistema."));

                // Se estiver a correr nativamente dentro do Apps Script
                if (window.google?.script?.run) {
                    return new Promise((resolve, reject) => {
                        const runner = window.google.script.run
                            .withSuccessHandler(resolve)
                            .withFailureHandler(error => reject(new Error(error?.message || "A chamada ao Apps Script falhou.")));

                        // Adiciona o token no final dos argumentos enviados para a função do Code.gs
                        runner[method](...args, accessToken);
                    });
                }

                // Se estiver a correr localmente na máquina (usando o iframe da ponte)
                return new Promise((resolve, reject) => {
                    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
                    const timeout = window.setTimeout(() => {
                        const pending = pendingSyncCalls.get(requestId);
                        pendingSyncCalls.delete(requestId);
                        const message = !syncBridgeReady
                            ? "Não foi possível abrir a ponte do Apps Script. Confira o URL /exec, a autorização da implantação e a conexão; ou escolha “Continuar offline”."
                            : pending?.received
                                ? "O Apps Script recebeu o pedido, mas não respondeu. Confira a implantação e as permissões; ou escolha “Continuar offline”."
                                : "A ponte abriu, mas não confirmou o pedido. Atualize Bridge.html na implantação e tente novamente, ou escolha “Continuar offline”.";
                        reject(new Error(message));
                    }, appConfig.sync.timeoutMs);

                    pendingSyncCalls.set(requestId, {
                        resolve,
                        reject,
                        timeout,
                        received: false
                    });

                    // Junta os dados normais da sincronização com o token de segurança no array de argumentos
                    const payloadArgs = [...args, accessToken];

                    const postRequest = () => {
                        if (!pendingSyncCalls.has(requestId)) return;
                        if (!syncBridgeReady || !syncBridgeTarget) {
                            window.setTimeout(postRequest, 100);
                            return;
                        }
                        // Envia o pacote com o método, ID e os argumentos (incluindo o token)
                        syncBridgeTarget.postMessage({
                            channel: "cras-sync-bridge",
                            id: requestId,
                            method,
                            args: payloadArgs
                        }, "*");
                    };
                    postRequest();
                });
            }

            window.addEventListener("message", event => {
                const isAppsScriptOrigin = event.origin === "https://script.google.com"
                    || /^https:\/\/[^/]+\.googleusercontent\.com$/.test(event.origin);
                if ((event.source !== syncBridgeFrame.contentWindow && !isAppsScriptOrigin)
                    || !event.data || event.data.channel !== "cras-sync-bridge") return;
                if (event.data.ready === true) {
                    syncBridgeTarget = event.source;
                    syncBridgeReady = true;
                    return;
                }
                if (typeof event.data.id !== "string") return;
                const pending = pendingSyncCalls.get(event.data.id);
                if (!pending) return;
                if (event.data.received === true) {
                    pending.received = true;
                    return;
                }
                window.clearTimeout(pending.timeout);
                pendingSyncCalls.delete(event.data.id);
                if (event.data.ok) pending.resolve(event.data.result);
                else pending.reject(new Error(event.data.error || "A conexão com o Google falhou."));
            });

            function canonicalSyncValue(value) {
                if (Array.isArray(value)) return value.map(canonicalSyncValue);
                if (value && typeof value === "object") {
                    return Object.keys(value).sort().reduce((result, key) => {
                        result[key] = canonicalSyncValue(value[key]);
                        return result;
                    }, {});
                }
                return value;
            }

            function syncValuesEqual(left, right) {
                return JSON.stringify(canonicalSyncValue(left)) === JSON.stringify(canonicalSyncValue(right));
            }

            function hasOwnValue(value, key, missing) {
                return value && Object.hasOwn(value, key) ? value[key] : missing;
            }

            async function protectTechnicalAnnotations(records) {
                const config = storageCache.get(STORAGE_TECHNICAL_E2EE);
                const protectedRecords = [];
                const persistedRecords = [];
                for (const record of records) {
                    const annotations = getAppointmentAnnotations(record);
                    const entries = Array.isArray(annotations.assistencia) ? annotations.assistencia : [];
                    let ciphertext = record.technicalAnnotationsCiphertext;
                    if (config && technicalEncryptionKey) {
                        const fingerprint = JSON.stringify(entries);
                        const previous = technicalPlaintextCache.get(record.id);
                        if (entries.length && (!previous || previous.fingerprint !== fingerprint || !ciphertext)) {
                            ciphertext = await encryptTechnicalValue(entries, technicalEncryptionKey, record.id);
                        }
                        if (entries.length) {
                            technicalPlaintextCache.set(record.id, { fingerprint, entries });
                        } else {
                            technicalPlaintextCache.delete(record.id);
                        }
                    } else if (config && entries.length) {
                        throw new Error("Desbloqueie a chave técnica antes de alterar ou salvar anotações técnicas.");
                    }
                    if (config && entries.length && !ciphertext) {
                        throw new Error("Não foi possível criptografar uma anotação técnica.");
                    }
                    const runtimeRecord = {
                        ...record,
                        ...(ciphertext ? { technicalAnnotationsCiphertext: ciphertext } : {})
                    };
                    const persistedRecord = {
                        ...runtimeRecord,
                        annotations: {
                            ...annotations,
                            assistencia: config ? [] : entries
                        }
                    };
                    if (config && !ciphertext) delete persistedRecord.technicalAnnotationsCiphertext;
                    if (config && !technicalEncryptionKey) {
                        runtimeRecord.annotations = { ...annotations, assistencia: [] };
                    }
                    protectedRecords.push(runtimeRecord);
                    persistedRecords.push(persistedRecord);
                }
                records.splice(0, records.length, ...protectedRecords);
                return persistedRecords;
            }

            async function unlockTechnicalAnnotations(records, key) {
                const unlocked = [];
                for (const record of records) {
                    const envelope = record.technicalAnnotationsCiphertext;
                    if (!envelope) {
                        unlocked.push(record);
                        continue;
                    }
                    const entries = await decryptTechnicalValue(envelope, key, record.id);
                    if (!Array.isArray(entries)) {
                        throw new Error("Uma anotação técnica criptografada contém dados inválidos.");
                    }
                    const fingerprint = JSON.stringify(entries);
                    technicalPlaintextCache.set(record.id, { fingerprint, entries });
                    unlocked.push({
                        ...record,
                        annotations: {
                            ...getAppointmentAnnotations(record),
                            assistencia: entries
                        }
                    });
                }
                return unlocked;
            }

            function lockTechnicalAnnotations(records) {
                technicalEncryptionKey = null;
                technicalPlaintextCache.clear();
                return records.map(record => ({
                    ...record,
                    annotations: {
                        ...getAppointmentAnnotations(record),
                        assistencia: []
                    }
                }));
            }

            function removePlainTechnicalAnnotations(value) {
                if (Array.isArray(value)) return value.map(removePlainTechnicalAnnotations);
                if (!value || typeof value !== "object") return value;
                const copy = Object.fromEntries(
                    Object.entries(value).map(([key, item]) => [key, removePlainTechnicalAnnotations(item)])
                );
                if (copy.annotations && typeof copy.annotations === "object"
                    && !Array.isArray(copy.annotations)) {
                    copy.annotations.assistencia = [];
                }
                return copy;
            }

            async function redactStoredSyncBases() {
                const keys = [
                    STORAGE_SYNC_BASE,
                    STORAGE_PEER_SYNC_BASES,
                    STORAGE_LOCAL_NODE_BASE_SNAPSHOT,
                    STORAGE_MOBILE_NODE_BASE_SNAPSHOT
                ];
                const updates = [];
                for (const key of keys) {
                    const setting = storageCache.has(key)
                        ? { value: storageCache.get(key) }
                        : await database.settings.get(key);
                    if (!setting) continue;
                    const current = setting.value;
                    const cleaned = key === STORAGE_PEER_SYNC_BASES
                        ? Object.fromEntries(Object.entries(current || {}).map(
                            ([peerId, snapshot]) => [peerId, removePlainTechnicalAnnotations(snapshot)]
                        ))
                        : removePlainTechnicalAnnotations(current);
                    updates.push({ key, value: cleaned });
                    storageCache.set(key, cleaned);
                }
                if (updates.length) {
                    await database.transaction("rw", database.settings, async () => {
                        await database.settings.bulkPut(updates);
                    });
                }
                syncBaseSnapshot = storageCache.get(STORAGE_SYNC_BASE) || null;
                peerSyncBaseSnapshots = storageCache.get(STORAGE_PEER_SYNC_BASES) || {};
                localNodeBaseSnapshot = storageCache.get(STORAGE_LOCAL_NODE_BASE_SNAPSHOT) || null;
                mobileNodeBaseSnapshot = storageCache.get(STORAGE_MOBILE_NODE_BASE_SNAPSHOT) || null;
            }

            function createSyncSnapshot() {
                const cleanPaaRecords = paaRecords.map(record => {
                    const cleanRecord = { ...record, cpf: formatCpf(record.cpf), telefone: formatPhone(record.telefone) };
                    delete cleanRecord.googleSyncedAt;
                    delete cleanRecord.googleSheetUnlinked;
                    return cleanRecord;
                }).sort((left, right) => left.id.localeCompare(right.id));
                const settings = {};
                SYNC_SETTING_KEYS.forEach(key => {
                    if (!storageCache.has(key)) return;
                    if (key === STORAGE_PREFERENCES) return;
                    const value = storageCache.get(key);
                    settings[key] = value;
                });
                const encryptedTechnicalAnnotations = Boolean(settings[STORAGE_TECHNICAL_E2EE]);
                const cleanAppointments = [...appointments].map(record => {
                    const cleanRecord = JSON.parse(JSON.stringify(record));
                    if (encryptedTechnicalAnnotations) {
                        if (getAnnotationEntries(record, "assistencia").length
                            && !record.technicalAnnotationsCiphertext) {
                            throw new Error("Uma anotação técnica precisa ser criptografada antes da sincronização.");
                        }
                        cleanRecord.annotations = {
                            ...getAppointmentAnnotations(cleanRecord),
                            assistencia: []
                        };
                    }
                    return cleanRecord;
                });
                return JSON.parse(JSON.stringify({
                    appointments: cleanAppointments.sort((left, right) => left.id.localeCompare(right.id)),
                    people: [...people].sort((left, right) => left.key.localeCompare(right.key)),
                    paaRecords: cleanPaaRecords,
                    settings
                }));
            }

            async function persistMobileSnapshotToServer(snapshot, actorRole = activeUser?.role) {
                let candidate = snapshot;
                for (let attempt = 0; attempt < 4; attempt += 1) {
                    try {
                        const result = await mobileRequest({
                            operation: "write",
                            snapshot: candidate,
                            expectedRevision: mobileNodeRevision,
                            actorRole
                        });
                        if (!Number.isSafeInteger(result.revision) || result.revision < 0) {
                            throw new Error("O computador retornou uma revisão móvel inválida.");
                        }
                        await rememberMobileServerState(candidate, result.revision);
                        mobileOfflineMode = false;
                        mobilePendingSync = false;
                        syncPendingChanges = false;
                        document.querySelector(".offline").textContent = "Conectado ao servidor CRAS";
                        updateSyncIndicator();
                        return;
                    } catch (error) {
                        if (error.status !== 409) throw error;
                        const current = await mobileRequest({ operation: "read" });
                        const merged = mergePeerSnapshots(
                            mobileNodeBaseSnapshot,
                            candidate,
                            current.snapshot,
                            actorRole,
                            current.actorRole
                        );
                        await applySyncedSnapshot(
                            merged,
                            { appointments: [], people: [], paaRecords: [], settings: {} },
                            [],
                            false
                        );
                        await rememberMobileServerState(current.snapshot, current.revision);
                        candidate = createSyncSnapshot();
                        if (attempt === 3) {
                            throw new Error("Os dados mudaram repetidamente. Tente sincronizar novamente.");
                        }
                    }
                }
            }

            async function refreshMobileSnapshotFromServer() {
                if (!mobileClient || !mobileAccessKey || mobileRefreshInProgress
                    || document.visibilityState !== "visible" || !navigator.onLine) return;
                mobileRefreshInProgress = true;
                try {
                    const state = await mobileRequest({ operation: "read" });
                    if (!Number.isSafeInteger(state.revision)) {
                        throw new Error("O servidor retornou uma revisão móvel inválida.");
                    }
                    const snapshotChanged = !mobileNodeBaseSnapshot
                        || !syncValuesEqual(state.snapshot, mobileNodeBaseSnapshot);
                    if (state.revision <= mobileNodeRevision && !snapshotChanged) return;
                    const currentSnapshot = createSyncSnapshot();
                    const merged = mergePeerSnapshots(
                        mobileNodeBaseSnapshot,
                        currentSnapshot,
                        state.snapshot,
                        activeUser?.role,
                        state.actorRole
                    );
                    const remoteUsers = state.snapshot.settings?.[STORAGE_USERS];
                    const baseUsers = mobileNodeBaseSnapshot?.settings?.[STORAGE_USERS];
                    if (Array.isArray(remoteUsers)
                        && (!Array.isArray(baseUsers)
                            || syncValuesEqual(currentSnapshot.settings[STORAGE_USERS], baseUsers)
                                && !syncValuesEqual(remoteUsers, baseUsers))) {
                        merged.settings[STORAGE_USERS] = remoteUsers;
                    }
                    await applySyncedSnapshot(
                        merged,
                        { appointments: [], people: [], paaRecords: [], settings: {} },
                        [],
                        false
                    );
                    await rememberMobileServerState(state.snapshot, state.revision);
                    mobileOfflineMode = false;
                    document.querySelector(".offline").textContent = "Conectado ao servidor CRAS";
                    updateSyncIndicator();
                    if (!syncValuesEqual(merged, state.snapshot)) {
                        scheduleLocalSnapshotPersist(activeUser?.role);
                    }
                } catch (error) {
                    if (error.status === 401 || error.status === 403) {
                        mobileAccessKey = null;
                        mobileOfflineMode = false;
                        void clearMobileOfflineCredentials();
                        document.documentElement.classList.remove("mobile-authenticated");
                        document.getElementById("access-gate").hidden = false;
                        document.getElementById("mobile-access-status").textContent =
                            "O acesso móvel foi desativado ou o código mudou. Atualize a página e autentique-se novamente.";
                    } else {
                        mobileOfflineMode = true;
                        document.querySelector(".offline").textContent = "Modo offline · alterações salvas neste celular";
                        updateSyncIndicator();
                        console.error("Não foi possível atualizar a fila no celular.", error);
                        showSyncStatus("Servidor indisponível. As alterações ficam salvas neste celular e serão sincronizadas quando a conexão voltar.", 10000);
                    }
                } finally {
                    mobileRefreshInProgress = false;
                }
            }

            function preserveChangesMadeDuringSync(capturedSnapshot, serverSnapshot, currentSnapshot) {
                const preserveCollectionChanges = (collection, capturedItems, serverItems, currentItems) => {
                    const identityField = collection === "people" ? "key" : "id";
                    const captured = new Map(capturedItems.map(item => [item[identityField], item]));
                    const server = new Map(serverItems.map(item => [item[identityField], item]));
                    const current = new Map(currentItems.map(item => [item[identityField], item]));
                    const ids = new Set([...captured.keys(), ...server.keys(), ...current.keys()]);
                    const result = [];
                    ids.forEach(id => {
                        const capturedValue = captured.has(id) ? captured.get(id) : null;
                        const currentValue = current.has(id) ? current.get(id) : null;
                        const value = syncValuesEqual(capturedValue, currentValue)
                            ? (server.has(id) ? server.get(id) : null)
                            : currentValue;
                        if (value !== null) result.push(value);
                    });
                    return result;
                };
                const settings = { ...serverSnapshot.settings };
                const keys = new Set([
                    ...Object.keys(capturedSnapshot.settings),
                    ...Object.keys(serverSnapshot.settings),
                    ...Object.keys(currentSnapshot.settings)
                ]);
                keys.forEach(key => {
                    const capturedValue = Object.prototype.hasOwnProperty.call(capturedSnapshot.settings, key)
                        ? capturedSnapshot.settings[key] : null;
                    const currentValue = Object.prototype.hasOwnProperty.call(currentSnapshot.settings, key)
                        ? currentSnapshot.settings[key] : null;
                    if (!syncValuesEqual(capturedValue, currentValue)) {
                        if (currentValue === null) delete settings[key];
                        else settings[key] = currentValue;
                    }
                });
                return {
                    appointments: preserveCollectionChanges(
                        "appointments", capturedSnapshot.appointments, serverSnapshot.appointments, currentSnapshot.appointments
                    ),
                    people: preserveCollectionChanges(
                        "people", capturedSnapshot.people || [], serverSnapshot.people || [], currentSnapshot.people || []
                    ),
                    paaRecords: preserveCollectionChanges(
                        "paaRecords", capturedSnapshot.paaRecords, serverSnapshot.paaRecords, currentSnapshot.paaRecords
                    ),
                    settings
                };
            }

            function syncMetadataRole(metadata, fallback, collection, path) {
                if (!metadata || typeof metadata !== "object") return fallback;
                if (collection === "appointments") {
                    const queue = path.includes("technicalAnnotationsCiphertext")
                        ? "assistencia"
                        : path.split("/").find(part => part === "assistencia" || part === "cadastro");
                    const queueMetadata = queue && metadata.queues?.[queue];
                    if (queueMetadata?.role) return queueMetadata.role;
                    if (metadata.general?.role) return metadata.general.role;
                }
                return metadata.last?.role || metadata.general?.role || fallback;
            }

            function syncRolePriority(role, collection, path) {
                if (role === "admin") return 100;
                if (collection === "appointments") {
                    const parts = path.split("/");
                    if (path.includes("technicalAnnotationsCiphertext")) {
                        return role === "assistant" ? 80 : 10;
                    }
                    if (parts.includes("assistencia")) return role === "reception" || role === "intern" ? 90 : role === "assistant" ? 80 : 10;
                    if (parts.includes("cadastro")) return role === "reception" || role === "intern" ? 90 : role === "caseworker" ? 80 : 10;
                    if (parts.includes("routeServices")) {
                        return role === "reception" || role === "intern" ? 90 : role === "assistant" || role === "caseworker" ? 70 : 10;
                    }
                    return role === "reception" || role === "intern" ? 80 : 10;
                }
                if (collection === "paaRecords") return role === "reception" || role === "intern" ? 80 : 10;
                return 10;
            }

            function mergeSyncMetadata(base, local, remote) {
                const merge = (baseValue, localValue, remoteValue) => {
                    if (syncValuesEqual(localValue, remoteValue)) return remoteValue;
                    if (syncValuesEqual(localValue, baseValue)) return remoteValue;
                    if (syncValuesEqual(remoteValue, baseValue)) return localValue;
                    if (localValue && remoteValue && typeof localValue === "object"
                        && typeof remoteValue === "object" && !Array.isArray(localValue)
                        && !Array.isArray(remoteValue)) {
                        if ("updatedAt" in localValue || "updatedAt" in remoteValue) {
                            return (localValue.updatedAt || "") > (remoteValue.updatedAt || "")
                                ? localValue : remoteValue;
                        }
                        const baseObject = baseValue && typeof baseValue === "object" ? baseValue : {};
                        const merged = {};
                        new Set([
                            ...Object.keys(baseObject),
                            ...Object.keys(localValue),
                            ...Object.keys(remoteValue)
                        ]).forEach(key => {
                            const value = merge(baseObject[key], localValue[key], remoteValue[key]);
                            if (value !== undefined) merged[key] = value;
                        });
                        return merged;
                    }
                    return remoteValue;
                };
                return merge(base, local, remote);
            }

            function mergeSyncValue(
                base, local, remote, collection, path, localRole, remoteRole, localMeta, remoteMeta, missing
            ) {
                const equal = (left, right) => left === missing || right === missing
                    ? left === right : syncValuesEqual(left, right);
                if (equal(local, remote)) return remote;
                if (equal(local, base)) return remote;
                if (equal(remote, base)) return local;

                if (local && remote && typeof local === "object" && typeof remote === "object"
                    && !Array.isArray(local) && !Array.isArray(remote)) {
                    const nextLocalMeta = local._syncMeta || localMeta;
                    const nextRemoteMeta = remote._syncMeta || remoteMeta;
                    const baseObject = base && typeof base === "object" && !Array.isArray(base) ? base : {};
                    const merged = {};
                    new Set([
                        ...Object.keys(baseObject),
                        ...Object.keys(local),
                        ...Object.keys(remote)
                    ]).forEach(key => {
                        if (key === "_syncMeta") return;
                        const value = mergeSyncValue(
                            hasOwnValue(baseObject, key, missing),
                            hasOwnValue(local, key, missing),
                            hasOwnValue(remote, key, missing),
                            collection,
                            `${path}/${key}`,
                            localRole,
                            remoteRole,
                            nextLocalMeta,
                            nextRemoteMeta,
                            missing
                        );
                        if (value !== missing) merged[key] = value;
                    });
                    if (local._syncMeta || remote._syncMeta) {
                        merged._syncMeta = mergeSyncMetadata(
                            baseObject._syncMeta, local._syncMeta, remote._syncMeta
                        );
                    }
                    return merged;
                }

                if (Array.isArray(local) && Array.isArray(remote)
                    && local.every(item => item && typeof item === "object" && !Array.isArray(item)
                        && typeof item.id === "string")
                    && remote.every(item => item && typeof item === "object" && !Array.isArray(item)
                        && typeof item.id === "string")) {
                    const baseItems = new Map((Array.isArray(base) ? base : [])
                        .filter(item => item && typeof item.id === "string").map(item => [item.id, item]));
                    const localItems = new Map(local.map(item => [item.id, item]));
                    const remoteItems = new Map(remote.map(item => [item.id, item]));
                    const merged = [];
                    new Set([...baseItems.keys(), ...localItems.keys(), ...remoteItems.keys()])
                        .forEach(id => {
                            const value = mergeSyncValue(
                                baseItems.get(id) ?? missing,
                                localItems.get(id) ?? missing,
                                remoteItems.get(id) ?? missing,
                                collection,
                                `${path}/${id}`,
                                localRole,
                                remoteRole,
                                localItems.get(id)?._syncMeta || localMeta,
                                remoteItems.get(id)?._syncMeta || remoteMeta,
                                missing
                            );
                            if (value !== missing) merged.push(value);
                        });
                    return merged;
                }

                const localActor = syncMetadataRole(localMeta, localRole, collection, path);
                const remoteActor = syncMetadataRole(remoteMeta, remoteRole, collection, path);
                return syncRolePriority(localActor, collection, path)
                    > syncRolePriority(remoteActor, collection, path) ? local : remote;
            }

            function chooseSyncConflict(conflict, localRole, remoteRole) {
                const path = `${conflict.collection}/${conflict.id || ""}/${conflict.key || ""}`;
                const localActor = syncMetadataRole(
                    conflict.local?._syncMeta, localRole, conflict.collection, path
                );
                const remoteActor = syncMetadataRole(
                    conflict.remote?._syncMeta, remoteRole, conflict.collection, path
                );
                return syncRolePriority(localActor, conflict.collection, path)
                    > syncRolePriority(remoteActor, conflict.collection, path) ? "local" : "remote";
            }

            function mergePeerSnapshots(baseSnapshot, localSnapshot, remoteSnapshot, localRole, remoteRole) {
                const missing = Symbol("missing");
                const base = baseSnapshot || { appointments: [], people: [], paaRecords: [], settings: {} };
                const mergeCollection = collection => {
                    const identityField = collection === "people" ? "key" : "id";
                    const baseItems = new Map((base[collection] || []).map(item => [item[identityField], item]));
                    const localItems = new Map((localSnapshot[collection] || []).map(item => [item[identityField], item]));
                    const remoteItems = new Map((remoteSnapshot[collection] || []).map(item => [item[identityField], item]));
                    const merged = [];
                    new Set([...baseItems.keys(), ...localItems.keys(), ...remoteItems.keys()])
                        .forEach(id => {
                            const value = mergeSyncValue(
                                baseItems.get(id) ?? missing,
                                localItems.get(id) ?? missing,
                                remoteItems.get(id) ?? missing,
                                collection,
                                `${collection}/${id}`,
                                localRole,
                                remoteRole,
                                localItems.get(id)?._syncMeta,
                                remoteItems.get(id)?._syncMeta,
                                missing
                            );
                            if (value !== missing) merged.push(value);
                        });
                    return merged;
                };
                const baseSettings = base.settings || {};
                const localSettings = localSnapshot.settings || {};
                const remoteSettings = remoteSnapshot.settings || {};
                const settings = {};
                new Set([
                    ...Object.keys(baseSettings),
                    ...Object.keys(localSettings),
                    ...Object.keys(remoteSettings)
                ]).forEach(key => {
                    const value = mergeSyncValue(
                        Object.hasOwn(baseSettings, key) ? baseSettings[key] : missing,
                        Object.hasOwn(localSettings, key) ? localSettings[key] : missing,
                        Object.hasOwn(remoteSettings, key) ? remoteSettings[key] : missing,
                        "settings",
                        `settings/${key}`,
                        localRole,
                        remoteRole,
                        null,
                        null,
                        missing
                    );
                    if (value !== missing) settings[key] = value;
                });
                return {
                    appointments: mergeCollection("appointments"),
                    people: mergeCollection("people"),
                    paaRecords: mergeCollection("paaRecords"),
                    settings
                };
            }

            function showSyncStatus(message, duration = 6000) {
                const status = document.getElementById("sync-status");
                window.clearTimeout(syncStatusTimer);
                if (preferences.showSyncMessages === false) {
                    status.hidden = true;
                    return;
                }
                status.textContent = message;
                status.hidden = false;
                if (duration > 0) {
                    syncStatusTimer = window.setTimeout(() => {
                        status.hidden = true;
                    }, duration);
                }
            }

            async function applySyncedSnapshot(snapshot, baseSnapshot, unlinkedPaaIds = [], updatePeerBase = true) {
                if (!snapshot || !Array.isArray(snapshot.appointments) || !Array.isArray(snapshot.people)
                    || !Array.isArray(snapshot.paaRecords)
                    || !snapshot.settings || typeof snapshot.settings !== "object") {
                    throw new Error("O servidor retornou um pacote de sincronização inválido.");
                }
                const nextSettings = { ...snapshot.settings };
                const hasSnapshotSetting = key => Object.prototype.hasOwnProperty.call(nextSettings, key);
                const persistedSettings = new Set(Object.keys(snapshot.settings));
                const remotePreferences = nextSettings[STORAGE_PREFERENCES];
                if (hasSnapshotSetting(STORAGE_PREFERENCES)
                    && (!remotePreferences || typeof remotePreferences !== "object" || Array.isArray(remotePreferences))) {
                    throw new Error("As preferências retornadas pelo servidor têm formato inválido.");
                }
                persistedSettings.delete(STORAGE_PREFERENCES);
                const nextPreferences = preferences;
                nextSettings[STORAGE_PREFERENCES] = nextPreferences;
                const nextRoutes = hasSnapshotSetting(STORAGE_ROUTES) ? nextSettings[STORAGE_ROUTES] : routes;
                const nextAssistants = hasSnapshotSetting(STORAGE_ASSISTANTS) ? nextSettings[STORAGE_ASSISTANTS] : assistants;
                const nextUsers = hasSnapshotSetting(STORAGE_USERS)
                    ? nextSettings[STORAGE_USERS]
                    : nextAssistants.map((assistant, index) => ({
                        id: `assistant-${index + 1}`,
                        ...assistant,
                        role: "assistant"
                    }));
                const nextNationalities = hasSnapshotSetting(STORAGE_NATIONALITIES)
                    ? nextSettings[STORAGE_NATIONALITIES] : nationalities;
                const nextRouteQueueTags = hasSnapshotSetting(STORAGE_ROUTE_QUEUE_TAGS)
                    ? nextSettings[STORAGE_ROUTE_QUEUE_TAGS] : routeQueueTags;
                if (!Array.isArray(nextRoutes) || !Array.isArray(nextAssistants) || !Array.isArray(nextUsers)
                    || !Array.isArray(nextNationalities)
                    || !nextRouteQueueTags || typeof nextRouteQueueTags !== "object" || Array.isArray(nextRouteQueueTags)) {
                    throw new Error("As configurações retornadas pelo servidor têm formato inválido.");
                }
                if (nextUsers.some(user => !user || typeof user.id !== "string" || typeof user.name !== "string"
                    || typeof user.color !== "string" || !/^#[0-9a-f]{6}$/i.test(user.color)
                    || (user.canAttendTechnical !== undefined && typeof user.canAttendTechnical !== "boolean")
                    || !["assistant", "caseworker", "reception", "intern", "admin"].includes(user.role))) {
                    throw new Error("A lista de usuários retornada pelo servidor é inválida.");
                }
                nextUsers.forEach(user => {
                    user.canAttendTechnical = user.role === "admin" && user.canAttendTechnical === true;
                });
                const hasTechnicalE2EE = hasSnapshotSetting(STORAGE_TECHNICAL_E2EE);
                let nextAppointments = snapshot.appointments;
                let persistedAppointments = snapshot.appointments;
                if (activeUser?.role === "assistant" && technicalEncryptionKey && hasTechnicalE2EE) {
                    nextAppointments = await unlockTechnicalAnnotations(snapshot.appointments, technicalEncryptionKey);
                } else if (activeUser && activeUser.role !== "assistant") {
                    nextAppointments = snapshot.appointments.map(record => ({
                        ...record,
                        annotations: {
                            ...getAppointmentAnnotations(record),
                            assistencia: []
                        }
                    }));
                    if (!hasTechnicalE2EE) {
                        persistedAppointments = nextAppointments;
                    }
                }
                const nextPeople = snapshot.people;
                const syncedPaaIds = new Set(baseSnapshot.paaRecords.map(record => record.id));
                const unlinkedPaaIdSet = new Set(unlinkedPaaIds);
                const nextPaaRecords = snapshot.paaRecords.map(record => ({
                    ...record,
                    cpf: String(record.cpf || "").replace(/\D/g, ""),
                    telefone: String(record.telefone || "").replace(/\D/g, ""),
                    ...(syncedPaaIds.has(record.id)
                        ? {
                            googleSyncedAt: new Date().toISOString(),
                            ...(unlinkedPaaIdSet.has(record.id) ? { googleSheetUnlinked: true } : {})
                        }
                        : {})
                }));
                const previousAppointments = storageCache.get(STORAGE_RECORDS) || [];
                const nextAppointmentIds = new Set(nextAppointments.map(record => record.id));
                const appointmentIdsToDelete = previousAppointments
                    .filter(record => !nextAppointmentIds.has(record.id))
                    .map(record => record.id);
                const nextPeerSyncBaseSnapshots = { ...peerSyncBaseSnapshots };
                if (updatePeerBase && window.CRASDesktop && activePeerId) {
                    nextPeerSyncBaseSnapshots[activePeerId] = baseSnapshot;
                }
                await database.transaction("rw", database.appointments, database.settings, async () => {
                    if (appointmentIdsToDelete.length) {
                        await database.appointments.bulkDelete(appointmentIdsToDelete);
                    }
                    if (persistedAppointments.length) await database.appointments.bulkPut(persistedAppointments);
                    const settingRows = SYNC_SETTING_KEYS
                        .filter(key => persistedSettings.has(key))
                        .map(key => ({ key, value: nextSettings[key] }));
                    settingRows.push(
                        { key: STORAGE_PAA_RECORDS, value: nextPaaRecords },
                        { key: STORAGE_PEOPLE, value: nextPeople }
                    );
                    if (updatePeerBase) {
                        settingRows.push(
                            { key: STORAGE_SYNC_BASE, value: baseSnapshot },
                            { key: STORAGE_PEER_SYNC_BASES, value: nextPeerSyncBaseSnapshots }
                        );
                    }
                    await database.settings.bulkPut(settingRows);
                });
                storageCache.set(STORAGE_RECORDS, nextAppointments);
                storageCache.set(STORAGE_PEOPLE, nextPeople);
                SYNC_SETTING_KEYS.forEach(key => {
                    if (persistedSettings.has(key)) storageCache.set(key, nextSettings[key]);
                });
                storageCache.set(STORAGE_PAA_RECORDS, nextPaaRecords);
                if (updatePeerBase) {
                    storageCache.set(STORAGE_SYNC_BASE, baseSnapshot);
                    storageCache.set(STORAGE_PEER_SYNC_BASES, nextPeerSyncBaseSnapshots);
                    peerSyncBaseSnapshots = nextPeerSyncBaseSnapshots;
                }
                appointments = nextAppointments;
                people = nextPeople;
                paaRecords = nextPaaRecords;
                routes = nextRoutes;
                preferences = nextPreferences;
                users = nextUsers;
                const refreshedActiveUser = users.find(user => user.id === activeUser?.id);
                if (refreshedActiveUser) activeUser = userSnapshot(refreshedActiveUser);
                assistants = users.filter(isTechnicalUser)
                    .map(({ name, color }) => ({ name, color }));
                nationalities = nextNationalities;
                routeQueueTags = nextRouteQueueTags;
                if (updatePeerBase) syncBaseSnapshot = baseSnapshot;
                applyPreferences();
                renderChatRecipients();
                renderAssistants();
                renderLoginUsers();
                renderRoutes();
                renderNationalities();
                renderAll();
            }

            async function syncWithDesktopPeer(peer, actorRole) {
                const endpoint = getSyncBridgeUrl(peer.endpoint);
                const peerInfo = await fetchPeerInfo(endpoint);
                const localVersion = desktopNodeInfo?.appVersion;
                if (!localVersion || !peerInfo.appVersion
                    || localVersion.replace(/^v/, "") !== peerInfo.appVersion.replace(/^v/, "")) {
                    throw new Error(
                        `Versões incompatíveis para sincronização (${localVersion || "desconhecida"} e ${peerInfo.appVersion || "desconhecida"}). Atualize todos os dispositivos para a mesma versão.`
                    );
                }
                activePeerId = peerInfo.nodeId;
                syncBaseSnapshot = peerSyncBaseSnapshots[activePeerId] || null;
                const localSnapshot = createSyncSnapshot();
                const baseSnapshot = syncBaseSnapshot ? JSON.parse(JSON.stringify(syncBaseSnapshot)) : null;
                const resolutions = {};
                let result;
                for (let attempt = 0; attempt < 6; attempt += 1) {
                    result = await callSyncBackend(
                        "syncCrASSnapshot",
                        baseSnapshot,
                        localSnapshot,
                        resolutions,
                        actorRole,
                        { ...peer, endpoint, info: peerInfo }
                    );
                    if (!result || typeof result !== "object") {
                        throw new Error("O servidor retornou uma resposta de sincronização inválida.");
                    }
                    if (result.status !== "conflicts") break;
                    if (!Array.isArray(result.conflicts) || !result.conflicts.length) {
                        throw new Error("O servidor informou conflito sem detalhes suficientes.");
                    }
                    result.conflicts.forEach(conflict => {
                        resolutions[conflict.key] = chooseSyncConflict(
                            conflict, actorRole, result.actorRole
                        );
                    });
                }
                if (!result || result.status !== "ok" || !result.snapshot) {
                    throw new Error("Não foi possível concluir a sincronização dos conflitos. Tente novamente.");
                }
                const currentSnapshot = createSyncSnapshot();
                const snapshotToApply = preserveChangesMadeDuringSync(
                    localSnapshot, result.snapshot, currentSnapshot
                );
                await applySyncedSnapshot(snapshotToApply, result.snapshot, result.unlinkedPaaIds || []);
                await persistAcceptedPeerSnapshot(activePeerId, result.snapshot, actorRole);
                return result;
            }

            async function syncWithGoogle(manual = false, actorRole = activeUser?.role) {
                if (offlineMode) {
                    if (manual) showSyncStatus("Modo offline ativo. Os dados continuam salvos neste dispositivo.", 0);
                    return;
                }
                if (window.CRASDesktop && desktopNodeInfo?.centralServer) {
                    syncPendingChanges = false;
                    syncConnectionUnavailable = false;
                    updateSyncIndicator();
                    if (manual) showSyncStatus("Este computador é o servidor central; os dados já estão salvos no SQLite local.");
                    return;
                }
                if (syncInProgress || syncStartupInProgress) {
                    if (!manual) {
                        syncRequestedAfterCurrent = true;
                        queuedSyncRole = actorRole || queuedSyncRole;
                    }
                    return;
                }
                if (!navigator.onLine) {
                    if (manual) showSyncStatus("Sem conexão com a rede. Os dados continuam salvos neste dispositivo.");
                    return;
                }
                if (window.CRASDesktop && !desktopNodeInfo?.centralServer && activeUser) {
                    const syncingUser = users.find(user => user.id === activeUser.id);
                    if (!syncingUser?.passwordCredential) {
                        const message = "Este usuário ainda não tem uma senha individual sincronizada. Troque de usuário e crie ou valide a senha do servidor central.";
                        document.getElementById("central-server-discovery-status").textContent = message;
                        showSyncStatus(message, 10000);
                        return;
                    }
                }
                syncStartupInProgress = true;
                let desktopPeers = [];
                if (window.CRASDesktop) {
                    try {
                        desktopPeers = await discoverCentralServer();
                    } catch (error) {
                        syncStartupInProgress = false;
                        syncConnectionUnavailable = true;
                        updateSyncIndicator();
                        const message = `Não foi possível localizar o servidor central: ${error.message}`;
                        document.getElementById("central-server-discovery-status").textContent = message;
                        showSyncStatus(message, manual ? 0 : 10000);
                        return;
                    }
                }
                if (window.CRASDesktop && !desktopPeers.length) {
                    syncStartupInProgress = false;
                    syncConnectionUnavailable = true;
                    updateSyncIndicator();
                    const message = "Servidor central não encontrado. Os dados continuam salvos neste computador; confira se ele está ativo na mesma rede local.";
                    document.getElementById("central-server-discovery-status").textContent = message;
                    showSyncStatus(message, manual ? 0 : 10000);
                    return;
                }
                if (!window.CRASDesktop && !window.google?.script?.run && !getSyncBridgeUrl()) {
                    syncStartupInProgress = false;
                    if (manual) showSyncStatus("Configure o link publicado do Apps Script em Configurações para ativar a sincronização.");
                    return;
                }
                syncStartupInProgress = false;
                syncInProgress = true;
                updateSyncIndicator();
                if (manual) showSyncStatus(window.CRASDesktop
                    ? "Sincronizando dados com o servidor central…"
                    : "Sincronizando dados com o Google…", 0);
                try {
                    if (window.CRASDesktop) {
                        await refreshLocalNodeFromServer(true);
                        await persistLocalSnapshotToServer(createSyncSnapshot(), actorRole);
                        const results = [];
                        const failures = [];
                        for (const peer of desktopPeers) {
                            try {
                                const result = await syncWithDesktopPeer(peer, actorRole);
                                results.push(result);
                            } catch (error) {
                                failures.push(error.message);
                            }
                        }
                        if (!results.length) {
                            throw new Error(`Servidor central indisponível. Os dados continuam salvos neste dispositivo e serão reenviados quando a conexão voltar. ${failures.join(" | ")}`);
                        }
                        if (manual || failures.length) {
                            const details = failures.length ? ` Falharam: ${failures.join(" | ")}` : "";
                            showSyncStatus(
                                `Sincronização concluída com o servidor central.${details}`,
                                manual ? 0 : 10000
                            );
                        }
                        await rememberSuccessfulSync();
                        syncPendingChanges = false;
                        syncConnectionUnavailable = failures.length > 0;
                        return;
                    }
                    const localSnapshot = createSyncSnapshot();
                    const baseSnapshot = syncBaseSnapshot ? JSON.parse(JSON.stringify(syncBaseSnapshot)) : null;
                    const resolutions = {};
                    let result;
                    for (let attempt = 0; attempt < 6; attempt += 1) {
                        result = await callSyncBackend(
                            "syncCrASSnapshot", baseSnapshot, localSnapshot, resolutions, actorRole
                        );
                        if (!result || typeof result !== "object") {
                            throw new Error("O servidor retornou uma resposta de sincronização inválida.");
                        }
                        if (result.status !== "conflicts") break;
                        if (!Array.isArray(result.conflicts) || !result.conflicts.length) {
                            throw new Error("O servidor informou conflito sem detalhes suficientes.");
                        }
                        result.conflicts.forEach(conflict => {
                            resolutions[conflict.key] = chooseSyncConflict(
                                conflict, actorRole, result.actorRole
                            );
                        });
                    }
                    if (!result || result.status !== "ok" || !result.snapshot) {
                        throw new Error("Não foi possível concluir a sincronização dos conflitos. Tente novamente.");
                    }
                    const currentSnapshot = createSyncSnapshot();
                    const snapshotToApply = preserveChangesMadeDuringSync(localSnapshot, result.snapshot, currentSnapshot);
                    await applySyncedSnapshot(snapshotToApply, result.snapshot, result.unlinkedPaaIds || []);
                    await rememberSuccessfulSync();
                    syncPendingChanges = false;
                    syncConnectionUnavailable = false;
                    if (manual) {
                        const timestamp = new Intl.DateTimeFormat("pt-BR", { timeStyle: "short" }).format(new Date(result.syncedAt || Date.now()));
                        const unlinkedCount = Array.isArray(result.unlinkedPaaIds) ? result.unlinkedPaaIds.length : 0;
                        showSyncStatus(`Sincronização concluída às ${timestamp}.${unlinkedCount
                            ? ` ${unlinkedCount} registro(s) do PAA coincidem com linhas antigas e não vinculadas, que foram preservadas sem alteração.`
                            : ""}`);
                    }
                } catch (error) {
                    syncConnectionUnavailable = true;
                    console.error("Falha ao sincronizar os dados do CRAS.", error);
                    showSyncStatus(`Não foi possível sincronizar: ${error.message}`, manual ? 0 : 10000);
                } finally {
                    syncStartupInProgress = false;
                    syncInProgress = false;
                    updateSyncIndicator();
                    if (syncRequestedAfterCurrent) {
                        syncRequestedAfterCurrent = false;
                        window.setTimeout(() => {
                            const role = queuedSyncRole;
                            queuedSyncRole = null;
                            void syncWithGoogle(false, role);
                        }, 0);
                    }
                }
            }

            function setupGoogleSync() {
                const singlePeerSettings = document.getElementById("single-peer-settings");
                const desktopPaaSyncSettings = document.getElementById("desktop-paa-sync-settings");
                document.getElementById("sync-now").addEventListener("click", () => {
                    void syncWithGoogle(true);
                });
                document.getElementById("admin-operations-refresh").addEventListener("click", async event => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    try {
                        await refreshAutomaticBackupStatus();
                        await syncWithGoogle(true);
                        await updateMachineExportStatus();
                    } finally {
                        button.disabled = false;
                    }
                });
                document.getElementById("desktop-sync-settings-card").hidden = mobileClient;
                singlePeerSettings.hidden = mobileClient || window.CRASDesktop;
                desktopPaaSyncSettings.hidden = !window.CRASDesktop;
                if (!window.CRASDesktop && !mobileClient) {
                    document.querySelector('label[for="sync-app-url"]').textContent = "Link de sincronização do Apps Script";
                    document.querySelector('label[for="sync-peer-key"]').textContent = "Código do Apps Script";
                    document.getElementById("sync-app-url-save").textContent = "Salvar link do Apps Script";
                }
                if (window.CRASDesktop) {
                    document.getElementById("paa-google-connect").addEventListener("click", async event => {
                        const button = event.currentTarget;
                        const connectionStatus = document.getElementById("paa-google-status");
                        const endpointInput = document.getElementById("paa-google-sheet-url");
                        const tokenInput = document.getElementById("paa-google-access-token");
                        const endpoint = endpointInput.value.trim();
                        const token = tokenInput.value.trim();
                        if (!getGoogleAppsScriptBridgeUrl(endpoint)) {
                            connectionStatus.textContent = "Informe o URL publicado do Apps Script, terminado em /exec.";
                            showSyncStatus(connectionStatus.textContent);
                            endpointInput.focus();
                            return;
                        }
                        if (!token) {
                            connectionStatus.textContent = "Informe o token de acesso para conectar à planilha PAA.";
                            showSyncStatus(connectionStatus.textContent);
                            tokenInput.focus();
                            return;
                        }

                        button.disabled = true;
                        connectionStatus.textContent = "Conectando ao Google Sheets e validando o token…";
                        showSyncStatus(connectionStatus.textContent, 0);
                        try {
                            if (!await updatePreferences({ googleSheetEndpoint: endpoint })) {
                                throw new Error("Não foi possível salvar o endereço do Apps Script.");
                            }
                            accessToken = token;
                            configureSyncBridge();
                            if (await callSyncBackend("validateStartupToken") !== true) {
                                throw new Error("Token incorreto. Confira o token de acesso e tente novamente.");
                            }
                            const pendingCount = paaRecords.filter(record =>
                                !record.googleSyncedAt && !record.googleSheetUnlinked
                            ).length;
                            connectionStatus.textContent = pendingCount
                                ? `Conexão validada. ${pendingCount} registro(s) aguardam envio; abra a aba PAA e toque em “Enviar pendentes ao Google”.`
                                : "Conexão validada. Não há registros pendentes para enviar.";
                            showSyncStatus(connectionStatus.textContent);
                        } catch (error) {
                            accessToken = "";
                            configureSyncBridge();
                            connectionStatus.textContent = `Não foi possível conectar ao Google Sheets: ${error.message}`;
                            showSyncStatus(connectionStatus.textContent, 0);
                        } finally {
                            tokenInput.value = "";
                            button.disabled = false;
                        }
                    });
                    const centralServerToggle = document.getElementById("central-server-toggle");
                    centralServerToggle.addEventListener("change", async () => {
                        const enabled = centralServerToggle.checked;
                        centralServerToggle.disabled = true;
                        try {
                            const response = await fetchPeer("/api/central-config", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ enabled })
                            });
                            const result = await response.json();
                            if (!response.ok) throw new Error(result.error || "Não foi possível alterar o servidor central.");
                            desktopNodeInfo.centralServer = enabled;
                            updateServerTransferControls();
                            centralServerDiscoveryCache = null;
                            document.getElementById("central-server-discovery-status").textContent = enabled
                                ? "Este computador está anunciando o servidor central na rede local."
                                : "Este computador não é mais o servidor central.";
                            showSyncStatus(enabled
                                ? "Servidor central ativado. Os demais computadores o localizarão automaticamente."
                                : "Servidor central desativado neste computador.");
                            await updateMachineExportStatus();
                            if (!enabled && navigator.onLine) void syncWithGoogle();
                        } catch (error) {
                            centralServerToggle.checked = !enabled;
                            showSyncStatus(`Não foi possível alterar o servidor central: ${error.message}`, 0);
                        } finally {
                            centralServerToggle.disabled = false;
                        }
                    });
                } else {
                    document.getElementById("sync-app-url-save").addEventListener("click", async () => {
                        const input = document.getElementById("sync-app-url");
                        const endpoint = input.value.trim();
                        if (endpoint && !getSyncBridgeUrl(endpoint)) {
                            showSyncStatus("Link inválido. Use o URL implantado do Apps Script, terminado em /exec.");
                            input.focus();
                            return;
                        }
                        await updatePreferences({ syncEndpoint: endpoint, syncToken: "" });
                        if (endpoint && getSyncBridgeUrl()) {
                            showSyncStatus("Link salvo. A sincronização com o Google está configurada.");
                            if (navigator.onLine) void syncWithGoogle();
                        } else {
                            showSyncStatus("Link de sincronização removido deste dispositivo.");
                        }
                    });
                }
                window.addEventListener("online", () => {
                    syncConnectionUnavailable = false;
                    updateSyncIndicator();
                    if (mobileClient) {
                        if (!mobileAccessKey) return;
                        mobileOfflineMode = false;
                        scheduleLocalSnapshotPersist(activeUser?.role);
                        void refreshMobileSnapshotFromServer();
                        return;
                    }
                    void syncWithGoogle();
                });
                window.addEventListener("offline", () => {
                    updateSyncIndicator();
                });
                window.setInterval(() => {
                    if (!offlineMode && navigator.onLine) void syncWithGoogle();
                }, 30000);
                if (window.CRASDesktop) {
                    window.setInterval(() => void refreshLocalNodeFromServer(), 3000);
                }
                if (!offlineMode && navigator.onLine) window.setTimeout(() => syncWithGoogle(), 1500);
            }

            function getAppointmentWriteChanges(records) {
                const previousRecords = storageCache.get(STORAGE_RECORDS) || [];
                const previousById = new Map(previousRecords.map(record => [record.id, record]));
                const nextById = new Map(records.map(record => [record.id, record]));
                return {
                    recordsToWrite: records.filter(record => previousById.get(record.id) !== record),
                    idsToDelete: previousRecords.filter(record => !nextById.has(record.id)).map(record => record.id)
                };
            }

            function stampSyncAuthority(key, records, actorRole = activeUser?.role) {
                if (!Array.isArray(records) || !actorRole) return records;
                const previousRecords = storageCache.get(key) || [];
                const previousById = new Map(previousRecords.map(record => [record.id, record]));
                const queueOnlyFields = new Set([
                    "routeServices", "encaminhamentos", "encaminhamento", "tags"
                ]);
                records.forEach((record, index) => {
                    if (!record || typeof record !== "object" || typeof record.id !== "string") return;
                    const previous = previousById.get(record.id);
                    const previousContent = previous ? { ...previous } : null;
                    if (previousContent) delete previousContent._syncMeta;
                    const nextContent = { ...record };
                    delete nextContent._syncMeta;
                    if (previous && syncValuesEqual(previousContent, nextContent)) return;

                    const updatedAt = new Date().toISOString();
                    const metadata = record._syncMeta && typeof record._syncMeta === "object"
                        ? structuredClone(record._syncMeta) : {};
                    metadata.last = { role: actorRole, updatedAt };
                    if (key === STORAGE_PAA_RECORDS) {
                        metadata.general = { role: actorRole, updatedAt };
                    } else {
                        const previousFields = previous ? Object.keys(previousContent) : [];
                        const nextFields = Object.keys(nextContent);
                        const changedFields = new Set([...previousFields, ...nextFields].filter(field =>
                            !queueOnlyFields.has(field)
                            && !syncValuesEqual(previousContent?.[field], nextContent[field])));
                        if (!previous || changedFields.size || actorRole === "admin") {
                            metadata.general = { role: actorRole, updatedAt };
                        }
                        if (actorRole === "admin") {
                            metadata.queues = {
                                ...(metadata.queues || {}),
                                assistencia: { role: actorRole, updatedAt },
                                cadastro: { role: actorRole, updatedAt }
                            };
                        } else if (actorRole === "assistant" || actorRole === "caseworker") {
                            const previousServices = previousContent?.routeServices || [];
                            const nextServices = nextContent.routeServices || [];
                            if (!syncValuesEqual(previousServices, nextServices)) {
                                const queue = actorRole === "assistant" ? "assistencia" : "cadastro";
                                metadata.queues = {
                                    ...(metadata.queues || {}),
                                    [queue]: { role: actorRole, updatedAt }
                                };
                            }
                        } else if (actorRole === "reception" || actorRole === "intern") {
                            const previousServices = previousContent?.routeServices || [];
                            const nextServices = nextContent.routeServices || [];
                            if (!syncValuesEqual(previousServices, nextServices)) {
                                metadata.queues = {
                                    ...(metadata.queues || {}),
                                    assistencia: { role: actorRole, updatedAt },
                                    cadastro: { role: actorRole, updatedAt }
                                };
                            }
                        }
                    }
                    records[index] = { ...record, _syncMeta: metadata };
                });
                return records;
            }

            async function saveStorage(key, value) {
                try {
                    const actorRole = activeUser?.role;
                    if (key === STORAGE_RECORDS || key === STORAGE_PAA_RECORDS) {
                        stampSyncAuthority(key, value, actorRole);
                    }
                    if (key === STORAGE_RECORDS) {
                        const persistedRecords = await protectTechnicalAnnotations(value);
                        const { recordsToWrite, idsToDelete } = getAppointmentWriteChanges(persistedRecords);
                        await database.transaction("rw", database.appointments, async () => {
                            if (idsToDelete.length) await database.appointments.bulkDelete(idsToDelete);
                            if (recordsToWrite.length) await database.appointments.bulkPut(recordsToWrite);
                        });
                    } else {
                        await database.settings.put({ key, value });
                    }
                    storageCache.set(key, value);
                    scheduleLocalSnapshotPersist(actorRole);
                    schedulePeerSync(actorRole);
                    if (key === STORAGE_RECORDS || key === STORAGE_PAA_RECORDS || SYNC_SETTING_KEYS.includes(key)) {
                        syncPendingChanges = true;
                        updateSyncIndicator();
                    }
                    return true;
                } catch (error) {
                    console.error("Falha ao salvar dados no IndexedDB.", error);
                    showToast("Não foi possível salvar os dados neste dispositivo. Confira o espaço disponível.");
                    return false;
                }
            }

            function mergeUnique(existingItems, newItems, getKey) {
                const merged = [...existingItems];
                const knownKeys = new Set(merged.map(item => getKey(item).toLocaleLowerCase("pt-BR")));
                newItems.forEach(item => {
                    const key = getKey(item).toLocaleLowerCase("pt-BR");
                    if (knownKeys.has(key)) return;
                    knownKeys.add(key);
                    merged.push(item);
                });
                return merged;
            }

            async function saveImportedStorage(records, importedPeople, importedRoutes, importedAssistants, importedUsers, importedNationalities, importedRouteQueueTags, importedPaaRecords, technicalE2EE) {
                try {
                    const actorRole = activeUser?.role;
                    stampSyncAuthority(STORAGE_RECORDS, records, actorRole);
                    stampSyncAuthority(STORAGE_PAA_RECORDS, importedPaaRecords, actorRole);
                    const persistedRecords = await protectTechnicalAnnotations(records);
                    const { recordsToWrite, idsToDelete } = getAppointmentWriteChanges(persistedRecords);
                    await database.transaction("rw", database.appointments, database.settings, async () => {
                        if (idsToDelete.length) await database.appointments.bulkDelete(idsToDelete);
                        if (recordsToWrite.length) await database.appointments.bulkPut(recordsToWrite);
                        const updates = [
                            [STORAGE_ROUTES, importedRoutes],
                            [STORAGE_ROUTE_QUEUE_TAGS, importedRouteQueueTags],
                            [STORAGE_ASSISTANTS, importedAssistants],
                            [STORAGE_USERS, importedUsers],
                            [STORAGE_NATIONALITIES, importedNationalities],
                            [STORAGE_PAA_RECORDS, importedPaaRecords],
                            [STORAGE_PEOPLE, importedPeople]
                        ];
                        if (technicalE2EE) updates.push([STORAGE_TECHNICAL_E2EE, technicalE2EE]);
                        for (const [key, value] of updates) await database.settings.put({ key, value });
                    });
                    storageCache.set(STORAGE_RECORDS, records);
                    storageCache.set(STORAGE_ROUTES, importedRoutes);
                    storageCache.set(STORAGE_ROUTE_QUEUE_TAGS, importedRouteQueueTags);
                    storageCache.set(STORAGE_ASSISTANTS, importedAssistants);
                    storageCache.set(STORAGE_USERS, importedUsers);
                    storageCache.set(STORAGE_NATIONALITIES, importedNationalities);
                    storageCache.set(STORAGE_PAA_RECORDS, importedPaaRecords);
                    storageCache.set(STORAGE_PEOPLE, importedPeople);
                    scheduleLocalSnapshotPersist(actorRole);
                    schedulePeerSync(actorRole);
                    return true;
                } catch (error) {
                    console.error("Falha ao importar dados para o IndexedDB.", error);
                    showToast("Não foi possível salvar o backup no armazenamento deste navegador.");
                    return false;
                }
            }

            function escapeHtml(value) {
                return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
            }

            function showToast(message, kind = "info") {
                toast.textContent = message;
                toast.dataset.kind = ["success", "warning", "error"].includes(kind) ? kind : "info";
                toast.classList.add("visible");
                clearTimeout(showToast.timer);
                showToast.timer = setTimeout(() => toast.classList.remove("visible"), 2800);
            }

            function renderAssistantAdminList(items = users) {
                const list = document.getElementById("assistant-admin-list");
                list.innerHTML = items.map(user => {
                const protectedUser = user.id === SYSTEM_ADMIN_USER_ID;
                return `<div class="assistant-admin-row" data-user-id="${escapeHtml(user.id)}">
                <label>Nome<input type="text" data-user-name value="${escapeHtml(user.name)}" maxlength="60" required ${protectedUser ? "readonly" : ""}></label>
                <label>Perfil<select class="select-input" data-user-role ${protectedUser ? "disabled" : ""}>
                    <option value="assistant" ${user.role === "assistant" ? "selected" : ""}>Técnico</option>
                    <option value="caseworker" ${user.role === "caseworker" ? "selected" : ""}>Cadastradora</option>
                    <option value="reception" ${user.role === "reception" ? "selected" : ""}>Recepção</option>
                    <option value="intern" ${user.role === "intern" ? "selected" : ""}>Estagiário</option>
                    <option value="admin" ${user.role === "admin" ? "selected" : ""}>Admin</option>
                </select></label>
                <label>Cor<input type="color" data-user-color value="${escapeHtml(user.color)}" aria-label="Cor de ${escapeHtml(user.name)}"></label>
                <button type="button" data-user-remove aria-label="Remover ${escapeHtml(user.name)}" title="${protectedUser ? "Conta protegida" : "Remover"}" ${protectedUser ? "disabled" : ""}>×</button>
                <label data-admin-technical ${user.role === "admin" ? "" : "hidden"}><input type="checkbox" data-user-technical ${user.canAttendTechnical === true ? "checked" : ""}> Também pode ser designado como Técnico</label>
                </div>`;
                }).join("");
                list.querySelectorAll("[data-user-role]").forEach(select => {
                    select.addEventListener("change", () => {
                        const row = select.closest(".assistant-admin-row");
                        row.querySelector("[data-admin-technical]").hidden = select.value !== "admin";
                    });
                });
                list.querySelectorAll("[data-user-remove]").forEach(button => {
                    button.addEventListener("click", () => {
                        const row = button.closest(".assistant-admin-row");
                        if (row.dataset.userId === SYSTEM_ADMIN_USER_ID) return;
                        if (!window.confirm(`Remover o usuário “${row.querySelector("[data-user-name]").value}” da lista?`)) return;
                        row.remove();
                    });
                });
            }

            async function refreshMobileAccessStatus() {
                const section = document.getElementById("mobile-admin-settings");
                section.hidden = !window.CRASDesktop || activeUser?.role !== "admin";
                if (section.hidden) return;
                const status = document.getElementById("mobile-access-admin-status");
                try {
                    const response = await fetch("/api/mobile-info", { cache: "no-store" });
                    const info = await response.json();
                    if (!response.ok) throw new Error(info.error || "Não foi possível consultar o acesso móvel.");
                    status.textContent = info.enabled
                        ? "Acesso móvel ativado. O código atual não pode ser consultado."
                        : "Acesso móvel desativado.";
                } catch (error) {
                    console.error("Não foi possível consultar o acesso móvel.", error);
                    status.textContent = error.message || "Não foi possível consultar o acesso móvel.";
                }
            }

            function openAssistantAdmin() {
                if (activeUser?.role !== "admin") return;
                const overlay = document.getElementById("assistant-admin-overlay");
                document.getElementById("assistant-admin-content").hidden = false;
                overlay.hidden = false;
                renderAssistantAdminList();
                refreshMobileAccessStatus();
            }

            function closeAssistantAdmin() {
                document.getElementById("assistant-admin-overlay").hidden = true;
            }

            function setupAssistantAdmin() {
                const overlay = document.getElementById("assistant-admin-overlay");
                document.getElementById("assistant-admin-close").addEventListener("click", closeAssistantAdmin);
                overlay.addEventListener("click", event => {
                    if (event.target === overlay) closeAssistantAdmin();
                });
                document.addEventListener("keydown", event => {
                    if (event.key === "Escape" && !overlay.hidden) closeAssistantAdmin();
                });
                document.getElementById("mobile-access-save").addEventListener("click", async () => {
                    if (activeUser?.role !== "admin" || !window.CRASDesktop) return;
                    const pin = document.getElementById("mobile-admin-pin").value;
                    const confirmation = document.getElementById("mobile-admin-pin-confirm").value;
                    const status = document.getElementById("mobile-access-admin-status");
                    if (pin.length < 12 || pin.length > 128) {
                        status.textContent = "Use um código com pelo menos 12 caracteres.";
                        return;
                    }
                    if (pin !== confirmation) {
                        status.textContent = "Os códigos não coincidem.";
                        return;
                    }
                    const button = document.getElementById("mobile-access-save");
                    button.disabled = true;
                    status.textContent = "Salvando o código móvel…";
                    try {
                        const response = await fetch("/api/mobile-config", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ mobilePin: pin })
                        });
                        const result = await response.json();
                        if (!response.ok) throw new Error(result.error || "Não foi possível salvar o código móvel.");
                        status.textContent = "Código móvel salvo. Informe-o apenas à equipe autorizada.";
                        document.getElementById("mobile-admin-pin").value = "";
                        document.getElementById("mobile-admin-pin-confirm").value = "";
                    } catch (error) {
                        console.error("Não foi possível salvar o código móvel.", error);
                        status.textContent = error.message || "Não foi possível salvar o código móvel.";
                    } finally {
                        button.disabled = false;
                    }
                });
                document.getElementById("mobile-access-disable").addEventListener("click", async () => {
                    if (activeUser?.role !== "admin" || !window.CRASDesktop
                        || !window.confirm("Desativar o acesso pelo celular?")) return;
                    const status = document.getElementById("mobile-access-admin-status");
                    const button = document.getElementById("mobile-access-disable");
                    button.disabled = true;
                    try {
                        const response = await fetch("/api/mobile-config", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ mobilePin: "" })
                        });
                        const result = await response.json();
                        if (!response.ok) throw new Error(result.error || "Não foi possível desativar o acesso móvel.");
                        status.textContent = "Acesso móvel desativado.";
                        document.getElementById("mobile-admin-pin").value = "";
                        document.getElementById("mobile-admin-pin-confirm").value = "";
                    } catch (error) {
                        console.error("Não foi possível desativar o acesso móvel.", error);
                        status.textContent = error.message || "Não foi possível desativar o acesso móvel.";
                    } finally {
                        button.disabled = false;
                    }
                });
                document.getElementById("assistant-admin-add").addEventListener("click", () => {
                    const palette = ["#4b8061", "#bd8950", "#527c9b", "#9a6e8e", "#6f8d57", "#8a6eae"];
                    const color = palette[document.querySelectorAll(".assistant-admin-row").length % palette.length];
                    const items = Array.from(document.querySelectorAll(".assistant-admin-row")).map(row => ({
                        id: row.dataset.userId,
                        name: row.querySelector("[data-user-name]").value,
                        role: row.querySelector("[data-user-role]").value,
                        color: row.querySelector("[data-user-color]").value,
                        canAttendTechnical: row.querySelector("[data-user-technical]").checked
                    }));
                    items.push({ id: createUserId(), name: "", color, role: "assistant" });
                    renderAssistantAdminList(items);
                    document.querySelector(".assistant-admin-row:last-child [data-user-name]").focus();
                });
                document.getElementById("assistant-admin-save").addEventListener("click", async () => {
                    const nextUsers = Array.from(document.querySelectorAll(".assistant-admin-row")).map(row => {
                        const role = row.querySelector("[data-user-role]").value;
                        const existingUser = users.find(user => user.id === row.dataset.userId);
                        return {
                            id: row.dataset.userId || createUserId(),
                            name: row.querySelector("[data-user-name]").value.trim(),
                            role,
                            color: row.querySelector("[data-user-color]").value.toLowerCase(),
                            canAttendTechnical: role === "admin"
                                && row.querySelector("[data-user-technical]").checked,
                            ...(existingUser?.passwordCredential
                                ? { passwordCredential: existingUser.passwordCredential }
                                : {})
                        };
                    });
                    const protectedUser = users.find(user => user.id === SYSTEM_ADMIN_USER_ID);
                    if (protectedUser) {
                        const adminRow = nextUsers.find(user => user.id === SYSTEM_ADMIN_USER_ID);
                        if (adminRow) {
                            adminRow.name = SYSTEM_ADMIN_NAME;
                            adminRow.role = "admin";
                        } else {
                            nextUsers.unshift({ ...protectedUser, name: SYSTEM_ADMIN_NAME, role: "admin" });
                        }
                    }
                    if (!nextUsers.length || nextUsers.some(user => !user.name)) {
                        showToast("Mantenha pelo menos um usuário e preencha todos os nomes.");
                        return;
                    }
                    const names = nextUsers.map(user => user.name.toLocaleLowerCase("pt-BR"));
                    if (new Set(names).size !== names.length) {
                        showToast("Cada usuário precisa ter um nome diferente.");
                        return;
                    }
                    const nextAssistants = nextUsers.filter(isTechnicalUser)
                        .map(({ name, color }) => ({ name, color }));
                    try {
                        await database.transaction("rw", database.settings, async () => {
                            await database.settings.bulkPut([
                                { key: STORAGE_USERS, value: nextUsers },
                                { key: STORAGE_ASSISTANTS, value: nextAssistants }
                            ]);
                        });
                    } catch (error) {
                        console.error("Falha ao salvar a lista de usuários.", error);
                        showToast("Não foi possível salvar a lista de usuários neste dispositivo.");
                        return;
                    }
                    users = nextUsers;
                    storageCache.set(STORAGE_USERS, users);
                    storageCache.set(STORAGE_ASSISTANTS, nextAssistants);
                    assistants = nextAssistants;
                    const refreshedActiveUser = users.find(user => user.id === activeUser?.id);
                    if (refreshedActiveUser) activeUser = userSnapshot(refreshedActiveUser);
                    scheduleLocalSnapshotPersist(activeUser?.role);
                    schedulePeerSync(activeUser?.role);
                    applyActiveUserLayout();
                    renderAssistants();
                    renderLoginUsers();
                    renderAll();
                    showToast("Lista de usuários atualizada.");
                });
            }

            function dateKey(value) {
                const date = new Date(value);
                if (Number.isNaN(date.getTime())) return "";
                return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
            }

            async function refreshCurrentDay() {
                if (dayRefreshPromise) await dayRefreshPromise;
                const today = dateKey(new Date());
                if (!today) return;
                const dayChanged = today !== observedDayKey;
                if (!dayChanged && queueCleanupDayKey === today) return;
                observedDayKey = today;
                if (dayChanged && !editingAppointmentId && !appointmentDateEdited) {
                    appointmentDateInput.value = currentLocalDateTime();
                }
                dayRefreshPromise = (async () => {
                    const updatedAppointments = appointments.map(record => {
                        const recordDay = dateKey(record.createdAt);
                        if (!recordDay || recordDay >= today) return record;
                        const sourceServices = Array.isArray(record.routeServices)
                            ? record.routeServices
                            : getRecordServices(record);
                        const services = sourceServices.map(service => {
                            if (service.cancelled === true) return service;
                            const states = { ...(service.states || {}) };
                            const serviceTags = Array.isArray(service.queueTags)
                                ? service.queueTags
                                : getRouteQueueTags(service.route).filter(tag => tag !== QUEUE_TAG_NONE);
                            serviceTags.forEach(tag => {
                                const queueType = tag === QUEUE_TAGS.cadastro ? "cadastro" : "assistencia";
                                const state = { ...getServiceState(service, queueType) };
                                state.finished = true;
                                state.finishedAt = state.finishedAt || record.createdAt;
                                states[queueType] = state;
                            });
                            return { ...service, states };
                        });
                        if (Array.isArray(record.routeServices)
                            && services.every((service, index) => JSON.stringify(service) === JSON.stringify(record.routeServices[index]))) {
                            return record;
                        }
                        return { ...record, routeServices: services };
                    });
                    if (updatedAppointments.some((record, index) => record !== appointments[index])) {
                        if (await saveStorage(STORAGE_RECORDS, updatedAppointments)) {
                            appointments = updatedAppointments;
                            queueCleanupDayKey = today;
                        }
                    } else {
                        queueCleanupDayKey = today;
                    }
                    if (dayChanged) renderAll();
                })();
                try {
                    await dayRefreshPromise;
                } finally {
                    dayRefreshPromise = null;
                }
            }

            function scheduleDayRefresh() {
                window.clearTimeout(dayRefreshTimer);
                const nextMidnight = new Date();
                nextMidnight.setHours(24, 0, 0, 25);
                dayRefreshTimer = window.setTimeout(async () => {
                    await refreshCurrentDay();
                    await ensureQueueTimestamps();
                    await processQueueTimers();
                    scheduleSyncAfterActivation();
                    scheduleDayRefresh();
                }, Math.max(0, nextMidnight.getTime() - Date.now()));
            }

            function formatDateTime(value) {
                const date = new Date(value);
                return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" }).format(date);
            }

            function currentLocalDateTime() {
                const now = new Date();
                now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
                return now.toISOString().slice(0, 16);
            }

            function localDateTimeInput(value) {
                const date = new Date(value);
                if (Number.isNaN(date.getTime())) return "";
                const local = new Date(date.getTime() - (date.getTimezoneOffset() * 60000));
                return local.toISOString().slice(0, 16);
            }

            function formatCpf(value) {
                const digits = String(value ?? "").replace(/\D/g, "").slice(0, 11);
                return digits
                    .replace(/^(\d{3})(\d)/, "$1.$2")
                    .replace(/^(\d{3}\.\d{3})(\d)/, "$1.$2")
                    .replace(/^(\d{3}\.\d{3}\.\d{3})(\d{1,2})$/, "$1-$2");
            }

            function formatPhone(value) {
                const digits = String(value ?? "").replace(/\D/g, "").slice(0, 11);
                if (digits.length <= 2) return digits;
                const ddd = digits.slice(0, 2);
                const subscriber = digits.slice(2);
                if (subscriber.length <= 4) return `(${ddd}) ${subscriber}`;
                if (subscriber.length <= 8) return `(${ddd}) ${subscriber.slice(0, 4)}-${subscriber.slice(4)}`;
                return `(${ddd}) ${subscriber[0]} ${subscriber.slice(1, 5)}-${subscriber.slice(5)}`;
            }

            function formatInputValue(input, formatter, limit) {
                const digitPosition = input.value.slice(0, input.selectionStart ?? input.value.length).replace(/\D/g, "").length;
                const formatted = formatter(input.value);
                input.value = formatted;
                let cursor = 0;
                let digitsBeforeCursor = 0;
                while (cursor < formatted.length && digitsBeforeCursor < digitPosition) {
                    if (/\d/.test(formatted[cursor])) digitsBeforeCursor += 1;
                    cursor += 1;
                }
                while (cursor < formatted.length && !/\d/.test(formatted[cursor])) cursor += 1;
                input.setSelectionRange(cursor, cursor);
                if (limit) input.setCustomValidity(limit(input.value));
            }

            function formattedAddress(record) {
                const address = (record.endereco || "").trim();
                const number = (record.numero || "").trim();
                return address && number ? `${address}, ${number}` : address || number;
            }

            const REPORT_COLUMNS = [
                { key: "createdAt", label: "Data e hora", value: record => formatDateTime(record.createdAt) },
                { key: "nome", label: "Nome", value: record => record.nome || "" },
                { key: "endereco", label: "Endereço", value: record => record.endereco || "" },
                { key: "numero", label: "Número", value: record => record.numero || "" },
                { key: "cpf", label: "CPF", value: record => formatCpf(record.cpf) },
                { key: "telefone", label: "Telefone", value: record => formatPhone(record.telefone) },
                { key: "nacionalidade", label: "Nacionalidade", value: record => record.nacionalidade ?? record.etnia ?? "" },
                { key: "assistente", label: "Técnico(s)", value: record => record.assistente || "" },
                { key: "encaminhamento", label: "Encaminhamento", value: record => displayRouteName(record.encaminhamento || "") }
            ];

            function normalizeAutocompleteText(value) {
                return String(value ?? "").trim().toLocaleLowerCase("pt-BR")
                    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            }

            function normalizeOptionSearchText(value) {
                return normalizeAutocompleteText(value).replace(/[^\p{L}\p{N}]/gu, "");
            }

            function filterOptionCarousel(carousel, searchInput, emptyState) {
                const query = normalizeOptionSearchText(searchInput.value);
                let visibleOptions = 0;
                carousel.querySelectorAll(".route-option").forEach(option => {
                    const label = option.querySelector("label")?.textContent || "";
                    const matches = normalizeOptionSearchText(label).includes(query);
                    option.hidden = !matches;
                    if (matches) visibleOptions += 1;
                });
                emptyState.hidden = visibleOptions > 0;
            }

            function bindOptionCarouselSearch(carousel, searchInput, emptyState) {
                searchInput.addEventListener("input", () => filterOptionCarousel(carousel, searchInput, emptyState));
                carousel.addEventListener("click", event => {
                    if (event.target === carousel) carousel.focus();
                });
                carousel.addEventListener("keydown", event => {
                    if (event.key === "Escape") {
                        searchInput.value = "";
                        filterOptionCarousel(carousel, searchInput, emptyState);
                        event.preventDefault();
                        return;
                    }
                    if (event.key === "Backspace") {
                        searchInput.value = Array.from(searchInput.value).slice(0, -1).join("");
                        filterOptionCarousel(carousel, searchInput, emptyState);
                        event.preventDefault();
                        return;
                    }
                    if (event.key.length === 1 && /[\p{L}\p{N}]/u.test(event.key)) {
                        searchInput.value += event.key;
                        filterOptionCarousel(carousel, searchInput, emptyState);
                        event.preventDefault();
                    }
                });
            }

            function getHistoryPeople() {
                const latestFirst = [...appointments].sort((left, right) =>
                    new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
                const peopleByCpf = new Map();
                latestFirst.forEach(record => {
                    const cpf = String(record.cpf ?? "").replace(/\D/g, "");
                    if (!cpf) return;
                    const existing = peopleByCpf.get(cpf);
                    if (!existing) {
                        peopleByCpf.set(cpf, { ...record, cpf });
                        return;
                    }
                    ["nome", "telefone", "endereco", "numero", "nacionalidade", "etnia"].forEach(field => {
                        if (!existing[field] && record[field]) existing[field] = record[field];
                    });
                });
                return [...peopleByCpf.values()];
            }

            function getHistoryMatches(field, value) {
                const people = getHistoryPeople();
                if (field === "cpf") {
                    const digits = String(value ?? "").replace(/\D/g, "");
                    return digits.length === 11 ? people.filter(person => person.cpf === digits) : [];
                }
                if (field === "telefone") {
                    const digits = String(value ?? "").replace(/\D/g, "");
                    return digits.length >= 4 ? people.filter(person => String(person.telefone ?? "").replace(/\D/g, "").startsWith(digits)) : [];
                }
                const query = normalizeAutocompleteText(value);
                if (query.length < 2) return [];
                if (field === "nome") {
                    return people.filter(person => normalizeAutocompleteText(person.nome).includes(query));
                }
                if (field === "endereco") {
                    return query.length >= 3 ? people.filter(person =>
                        normalizeAutocompleteText(formattedAddress(person)).includes(query)) : [];
                }
                return [];
            }

            function describeHistoryPerson(person, field) {
                if (field === "nome") return `${formatCpf(person.cpf)} · ${formattedAddress(person) || "Endereço não informado"}`;
                if (field === "telefone") return `${formatPhone(person.telefone)} · ${person.nome || formatCpf(person.cpf)}`;
                if (field === "endereco") return `${formatCpf(person.cpf)} · ${person.nome || "Sem nome"} · ${formatPhone(person.telefone) || "Telefone não informado"}`;
                return `${person.nome || "Sem nome"} · ${formatPhone(person.telefone) || "Telefone não informado"} · ${formattedAddress(person) || "Endereço não informado"}`;
            }

            function closeHistorySuggestions() {
                Object.entries(historySuggestionElements).forEach(([field, element]) => {
                    element.hidden = true;
                    element.replaceChildren();
                    historyAutocompleteInputs[field].setAttribute("aria-expanded", "false");
                });
            }

            function updateHistorySuggestions(field, input) {
                const suggestions = historySuggestionElements[field];
                const matches = getHistoryMatches(field, input.value);
                suggestions.innerHTML = matches.map((person, index) => `
                    <button class="history-suggestion" type="button" role="option" data-person-index="${index}">
                        <strong>${escapeHtml(person.nome || "Sem nome")}</strong>
                        <span>${escapeHtml(describeHistoryPerson(person, field))}</span>
                    </button>`).join("");
                suggestions.hidden = matches.length === 0;
                input.setAttribute("aria-expanded", String(matches.length > 0));
            }

            function applyHistoryPerson(person) {
                if (!person) return;
                nameInput.value = capitalizeInitialLetters(person.nome || "");
                cpfInput.value = formatCpf(person.cpf);
                cpfInput.setCustomValidity("");
                phoneInput.value = formatPhone(person.telefone);
                phoneInput.setCustomValidity("");
                addressInput.value = capitalizeInitialLetters(person.endereco || "");
                numberInput.value = person.numero || "";
                const hasAddress = Boolean(addressInput.value.trim());
                numberInput.required = hasAddress;
                document.getElementById("numero-required").hidden = !hasAddress;
                const nationality = person.nacionalidade || person.etnia || "";
                const matchingNationality = nationalities.find(value =>
                    value.toLocaleLowerCase("pt-BR") === nationality.toLocaleLowerCase("pt-BR"));
                setNationalitySelection(matchingNationality || "");
                nameInput.setCustomValidity("");
                closeHistorySuggestions();
                formStatus.textContent = "Dados pessoais preenchidos com base no histórico. Confira antes de salvar.";
            }

            function closeHistoryAutocomplete(restoreFocus = true) {
                autocompleteOverlay.hidden = true;
                pendingAutocompletePeople = [];
                if (restoreFocus && autocompleteTrigger) autocompleteTrigger.focus();
                autocompleteTrigger = null;
            }

            function openHistoryAutocomplete(people, trigger) {
                if (!people.length) return;
                closeHistorySuggestions();
                autocompleteTrigger = trigger;
                pendingAutocompletePeople = people;
                const needsChoice = people.length > 1;
                autocompleteTitle.textContent = needsChoice
                    ? "Qual pessoa deseja selecionar?"
                    : "Confirmar preenchimento dos dados?";
                autocompleteMessage.textContent = needsChoice
                    ? "Há pessoas diferentes com esse dado no histórico. Escolha pelo CPF; cada pessoa aparece uma única vez."
                    : preferences.autoCompleteHistory
                        ? "Os dados desta pessoa serão preenchidos a partir do histórico."
                        : "Confirme se deseja preencher os dados desta pessoa a partir do histórico.";
                autocompleteList.innerHTML = people.map((person, index) => `
                    <label class="history-person-choice">
                        <input type="radio" name="history-person-selection" value="${index}" ${index === 0 ? "checked" : ""}>
                        <span><strong>${escapeHtml(person.nome || "Sem nome")}</strong><span>CPF ${escapeHtml(formatCpf(person.cpf))} · ${escapeHtml(formatPhone(person.telefone) || "Telefone não informado")} · ${escapeHtml(formattedAddress(person) || "Endereço não informado")}</span></span>
                    </label>`).join("");
                autocompleteSubmit.textContent = preferences.autoCompleteHistory ? "Completar dados" : "Confirmar e completar";
                autocompleteOverlay.hidden = false;
                const firstChoice = autocompleteList.querySelector("input");
                (needsChoice ? firstChoice : autocompleteCancel).focus();
            }

            function completeHistoryAutocomplete() {
                const selected = autocompleteList.querySelector("input[name='history-person-selection']:checked");
                const person = pendingAutocompletePeople[Number(selected?.value)];
                if (!person) {
                    showToast("Selecione uma pessoa para completar os dados.");
                    return;
                }
                const trigger = autocompleteTrigger;
                closeHistoryAutocomplete(false);
                applyHistoryPerson(person);
                if (trigger) trigger.focus();
                autocompleteTrigger = null;
            }

            function chooseHistoryPerson(person, trigger) {
                closeHistorySuggestions();
                if (preferences.autoCompleteHistory) {
                    applyHistoryPerson(person);
                    return;
                }
                openHistoryAutocomplete([person], trigger);
            }

            function requiresHistoryPersonChoice(field) {
                return field === "telefone" || field === "endereco";
            }

            function attachHistoryAutocomplete(field, input) {
                const suggestions = historySuggestionElements[field];
                let activeIndex = -1;
                const refresh = () => {
                    activeIndex = -1;
                    updateHistorySuggestions(field, input);
                };
                input.addEventListener("input", refresh);
                input.addEventListener("focus", refresh);
                if (field === "cpf") {
                    input.addEventListener("input", () => {
                        const matches = getHistoryMatches(field, input.value);
                        if (matches.length === 1) chooseHistoryPerson(matches[0], input);
                    });
                }
                input.addEventListener("blur", () => {
                    window.setTimeout(() => {
                        if (!suggestions.contains(document.activeElement)) {
                            suggestions.hidden = true;
                            input.setAttribute("aria-expanded", "false");
                        }
                    }, 0);
                });
                input.addEventListener("keydown", event => {
                    const matches = getHistoryMatches(field, input.value);
                    if (event.key === "Escape") {
                        suggestions.hidden = true;
                        input.setAttribute("aria-expanded", "false");
                        return;
                    }
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        if (!matches.length) return;
                        event.preventDefault();
                        const direction = event.key === "ArrowDown" ? 1 : -1;
                        activeIndex = (activeIndex + direction + matches.length) % matches.length;
                        suggestions.querySelectorAll(".history-suggestion").forEach((button, index) => {
                            button.classList.toggle("is-active", index === activeIndex);
                            button.setAttribute("aria-selected", String(index === activeIndex));
                        });
                        return;
                    }
                    if (event.key === "Enter" && matches.length) {
                        event.preventDefault();
                        if (activeIndex >= 0) chooseHistoryPerson(matches[activeIndex], input);
                        else if (matches.length > 1 && (requiresHistoryPersonChoice(field) || !preferences.autoCompleteHistory)) {
                            openHistoryAutocomplete(matches, input);
                        }
                        else if (preferences.autoCompleteHistory) applyHistoryPerson(matches[0]);
                        else chooseHistoryPerson(matches[0], input);
                        return;
                    }
                    if (event.key !== "Tab" || !matches.length) return;
                    if (matches.length > 1 && (requiresHistoryPersonChoice(field) || !preferences.autoCompleteHistory)) {
                        event.preventDefault();
                        openHistoryAutocomplete(matches, input);
                    } else if (preferences.autoCompleteHistory) {
                        if (matches.length > 1) event.preventDefault();
                        applyHistoryPerson(matches[0]);
                    } else {
                        event.preventDefault();
                        openHistoryAutocomplete(matches, input);
                    }
                });
                suggestions.addEventListener("pointerdown", event => event.preventDefault());
                suggestions.addEventListener("click", event => {
                    const button = event.target.closest(".history-suggestion");
                    if (!button) return;
                    const person = getHistoryMatches(field, input.value)[Number(button.dataset.personIndex)];
                    if (person) chooseHistoryPerson(person, input);
                });
            }

            function setAssistantSelection(value) {
                selectedAssistantValue = value;
                form.querySelectorAll("input[name='assistente']").forEach(radio => {
                    radio.checked = radio.value === value;
                });
            }

            assistantChoiceList.addEventListener("click", event => {
                const radio = event.target.closest("input[name='assistente']");
                if (!radio) return;
                event.preventDefault();
                selectedAssistantValue = selectedAssistantValue === radio.value ? "" : radio.value;
                const selection = selectedAssistantValue;
                window.setTimeout(() => setAssistantSelection(selection), 0);
            });
            assistantChoiceList.addEventListener("change", event => {
                const radio = event.target;
                if (radio instanceof HTMLInputElement && radio.name === "assistente" && radio.checked) {
                    selectedAssistantValue = radio.value;
                }
            });

            function renderAssistants() {
                const availableAssistants = activeUser?.role === "assistant"
                    ? assistants.filter(assistant => assistant.name === activeUser.name)
                    : assistants;
                const selectedAssistant = availableAssistants.some(assistant => assistant.name === selectedAssistantValue)
                    ? selectedAssistantValue
                    : activeUser?.role === "assistant" ? activeUser.name : "";
                assistantChoiceList.innerHTML = availableAssistants.map((assistant, index) => {
                    const id = `assistant-choice-${index}`;
                    return `<div class="choice-chip" style="--assistant-color:${escapeHtml(assistant.color)}"><input id="${id}" type="radio" name="assistente" value="${escapeHtml(assistant.name)}"><label for="${id}">${escapeHtml(assistant.name)}</label></div>`;
                }).join("");
                setAssistantSelection(selectedAssistant);
                const caseworkers = users.filter(user => user.role === "caseworker");
                const selectedCaseworker = activeUser?.role === "caseworker"
                    ? activeUser.id : caseworkerAssignment.value;
                caseworkerAssignment.innerHTML = `<option value="">Não definida</option>${caseworkers.map(user =>
                    `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)}</option>`
                ).join("")}`;
                if (caseworkers.some(user => user.id === selectedCaseworker)) caseworkerAssignment.value = selectedCaseworker;
                caseworkerAssignment.disabled = activeUser?.role === "caseworker";
                caseworkerAssignmentWrap.hidden = !getSelectedRoutes().some(route =>
                    getRouteQueueTags(route).includes(QUEUE_TAGS.cadastro));
                renderFilterOptions();
                renderDashboard();
            }

            function resetFormState() {
                form.reset();
                editingAppointmentId = null;
                formTitle.textContent = ["assistant", "caseworker"].includes(activeUser?.role)
                    ? "Registrar atendimento manual" : "Atendimento";
                submitButton.textContent = "Registrar atendimento";
                appointmentDateInput.value = currentLocalDateTime();
                appointmentDateEdited = false;
                cpfInput.setCustomValidity("");
                phoneInput.setCustomValidity("");
                setAssistantSelection("");
                setRouteSelection("");
                setNationalitySelection("");
                numberInput.required = false;
                document.getElementById("numero-required").hidden = true;
                routeOptions.hidden = true;
                routeTrigger.setAttribute("aria-expanded", "false");
                nationalityOptions.hidden = true;
                nationalityTrigger.setAttribute("aria-expanded", "false");
                formStatus.textContent = "Campos com * são obrigatórios.";
                updateAssistantRequirement();
            }

            function appointmentDraftKey() {
                return activeUser?.id ? `${STORAGE_APPOINTMENT_DRAFT_PREFIX}${activeUser.id}` : "";
            }

            function collectAppointmentDraft() {
                return {
                    nome: nameInput.value,
                    cpf: cpfInput.value,
                    telefone: phoneInput.value,
                    endereco: addressInput.value,
                    numero: numberInput.value,
                    appointmentDate: appointmentDateInput.value,
                    nationality: nationalityValue.value,
                    assistant: form.querySelector("input[name='assistente']:checked")?.value || "",
                    caseworker: caseworkerAssignment.value,
                    routes: getSelectedRoutes()
                };
            }

            async function saveAppointmentDraft() {
                const key = appointmentDraftKey();
                if (!key || editingAppointmentId) return;
                const draft = collectAppointmentDraft();
                const hasContent = Boolean(draft.nome.trim() || draft.cpf.trim() || draft.telefone.trim()
                    || draft.endereco.trim() || draft.numero.trim() || draft.nationality
                    || draft.assistant || draft.caseworker || draft.routes.length);
                if (!hasContent) {
                    await database.settings.delete(key);
                    document.getElementById("appointment-draft-controls").hidden = true;
                    document.getElementById("appointment-draft-saved").hidden = true;
                    return;
                }
                await database.settings.put({
                    key,
                    value: { savedAt: new Date().toISOString(), form: draft }
                });
                document.getElementById("appointment-draft-saved").hidden = false;
            }

            function scheduleAppointmentDraftSave() {
                if (editingAppointmentId || !activeUser) return;
                window.clearTimeout(appointmentDraftTimer);
                appointmentDraftTimer = window.setTimeout(() => {
                    saveAppointmentDraft().catch(error => {
                        console.error("Não foi possível salvar o rascunho do atendimento.", error);
                        showToast("Não foi possível salvar o rascunho neste dispositivo.");
                    });
                }, 400);
            }

            async function loadAppointmentDraft() {
                const key = appointmentDraftKey();
                const entry = key ? await database.settings.get(key) : null;
                const draft = entry?.value;
                const controls = document.getElementById("appointment-draft-controls");
                if (!draft?.form || typeof draft.form !== "object") {
                    controls.hidden = true;
                    return;
                }
                const savedAt = Date.parse(draft.savedAt || "");
                document.getElementById("appointment-draft-label").textContent = Number.isFinite(savedAt)
                    ? `Rascunho local salvo às ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(savedAt)}.`
                    : "Há um rascunho local deste usuário.";
                controls.hidden = false;
                document.getElementById("appointment-draft-saved").hidden = true;
            }

            async function restoreAppointmentDraft() {
                const key = appointmentDraftKey();
                const entry = key ? await database.settings.get(key) : null;
                const draft = entry?.value?.form;
                if (!draft || typeof draft !== "object") {
                    document.getElementById("appointment-draft-controls").hidden = true;
                    return;
                }
                nameInput.value = String(draft.nome || "");
                cpfInput.value = String(draft.cpf || "");
                phoneInput.value = String(draft.telefone || "");
                addressInput.value = String(draft.endereco || "");
                numberInput.value = String(draft.numero || "");
                if (typeof draft.appointmentDate === "string") appointmentDateInput.value = draft.appointmentDate;
                setAssistantSelection(String(draft.assistant || ""));
                setRouteSelection(Array.isArray(draft.routes) ? draft.routes : []);
                setNationalitySelection(String(draft.nationality || ""));
                caseworkerAssignment.value = String(draft.caseworker || "");
                numberInput.required = Boolean(addressInput.value.trim());
                document.getElementById("numero-required").hidden = !numberInput.required;
                updateAssistantRequirement();
                cpfInput.setCustomValidity("");
                phoneInput.setCustomValidity("");
                formStatus.textContent = "Rascunho restaurado. Confira os dados antes de registrar.";
                document.getElementById("appointment-draft-controls").hidden = true;
                document.getElementById("appointment-draft-saved").hidden = false;
                scheduleAppointmentDraftSave();
                nameInput.focus();
            }

            async function discardAppointmentDraft() {
                const key = appointmentDraftKey();
                if (key) await database.settings.delete(key);
                document.getElementById("appointment-draft-controls").hidden = true;
                document.getElementById("appointment-draft-saved").hidden = true;
                showToast("Rascunho descartado.");
            }

            function populateFormWithRecord(record) {
                if (!record) return;
                editingAppointmentId = record.id;
                formTitle.textContent = "Editar atendimento";
                submitButton.textContent = "Salvar alterações";
                nameInput.value = capitalizeInitialLetters(record.nome || "");
                cpfInput.value = formatCpf(record.cpf || "");
                phoneInput.value = formatPhone(record.telefone || "");
                cpfInput.setCustomValidity("");
                phoneInput.setCustomValidity("");
                addressInput.value = capitalizeInitialLetters(record.endereco || "");
                numberInput.value = record.numero || "";
                appointmentDateInput.value = localDateTimeInput(record.createdAt || new Date());
                setAssistantSelection(record.assistente || "");
                const storedServices = Array.isArray(record.routeServices)
                    ? record.routeServices.filter(service => service && service.cancelled !== true).map(service => service.route)
                    : Array.isArray(record.encaminhamentos) && record.encaminhamentos.length
                        ? record.encaminhamentos
                        : [record.encaminhamento].filter(Boolean);
                setRouteSelection(storedServices);
                const cadastralService = getRecordServices(record).find(service =>
                    service.queueTags.includes(QUEUE_TAGS.cadastro));
                caseworkerAssignment.value = cadastralService?.assignments?.cadastro?.id || "";
                setNationalitySelection(record.nacionalidade ?? record.etnia ?? "");
                const hasAddress = Boolean(addressInput.value.trim());
                numberInput.required = hasAddress;
                document.getElementById("numero-required").hidden = !hasAddress;
                updateAssistantRequirement();
                formStatus.textContent = `Editando atendimento de ${record.nome || "pessoa"}.`;
                nameInput.focus();
            }

            function getRouteQueueTags(route) {
                const tags = routeQueueTags[route];
                return Array.isArray(tags) && tags.length ? [...tags] : [QUEUE_TAG_NONE];
            }

            function getRoutesAvailableToActiveUser() {
                if (activeUser?.role === "assistant") {
                    return routes.filter(route => getRouteQueueTags(route).includes(QUEUE_TAGS.assistencia));
                }
                if (activeUser?.role === "caseworker") {
                    return routes.filter(route => getRouteQueueTags(route).includes(QUEUE_TAGS.cadastro));
                }
                return routes;
            }

            function displayRouteName(route) {
                return route === "Assistência" ? "Atendimento Técnico" : route;
            }

            async function saveRouteConfiguration(nextRoutes, nextRouteQueueTags) {
                try {
                    await database.transaction("rw", database.settings, async () => {
                        await database.settings.bulkPut([
                            { key: STORAGE_ROUTES, value: nextRoutes },
                            { key: STORAGE_ROUTE_QUEUE_TAGS, value: nextRouteQueueTags }
                        ]);
                    });
                    routes = nextRoutes;
                    routeQueueTags = nextRouteQueueTags;
                    storageCache.set(STORAGE_ROUTES, nextRoutes);
                    storageCache.set(STORAGE_ROUTE_QUEUE_TAGS, nextRouteQueueTags);
                    return true;
                } catch (error) {
                    console.error("Falha ao salvar configurações no IndexedDB.", error);
                    showToast("Não foi possível salvar as configurações do encaminhamento neste dispositivo.");
                    return false;
                }
            }

            function getSelectedRouteQueueTags() {
                const selected = [];
                if (routeQueueAssistance.checked) selected.push(QUEUE_TAGS.assistencia);
                if (routeQueueCadastro.checked) selected.push(QUEUE_TAGS.cadastro);
                if (routeQueueNone.checked) selected.push(QUEUE_TAG_NONE);
                return selected;
            }

            function updateRouteQueueConfirmation() {
                const tags = getSelectedRouteQueueTags();
                const valid = tags.length > 0
                    && !(tags.includes(QUEUE_TAG_NONE) && tags.length > 1);
                confirmRouteQueueButton.disabled = !valid;
                document.getElementById("route-queue-status").textContent = "";
            }

            async function confirmNewRoute() {
                const selectedTags = getSelectedRouteQueueTags();
                if (!pendingRouteName || !selectedTags.length
                    || (selectedTags.includes(QUEUE_TAG_NONE) && selectedTags.length > 1)) {
                    document.getElementById("route-queue-status").textContent = "Escolha uma fila antes de confirmar.";
                    routeQueueAssistance.focus();
                    return;
                }
                const nextRoutes = [...routes, pendingRouteName];
                const nextRouteQueueTags = { ...routeQueueTags, [pendingRouteName]: selectedTags };
                if (!await saveRouteConfiguration(nextRoutes, nextRouteQueueTags)) return;
                const newRoute = pendingRouteName;
                pendingRouteName = "";
                routeQueueOverlay.hidden = true;
                renderRoutes();
                setRouteSelection([...getSelectedRoutes(), newRoute]);
                newRouteInput.value = "";
                newRouteInput.focus();
            }

            function openRouteQueueDialog() {
                const value = newRouteInput.value.trim();
                if (!value) {
                    newRouteInput.focus();
                    return;
                }
                if (routes.some(route => route.toLocaleLowerCase("pt-BR") === value.toLocaleLowerCase("pt-BR"))) {
                    showToast("Esse encaminhamento já está cadastrado.");
                    newRouteInput.focus();
                    return;
                }
                pendingRouteName = value;
                document.getElementById("route-queue-name").textContent = `Encaminhamento: ${value}`;
                [routeQueueAssistance, routeQueueCadastro, routeQueueNone].forEach(input => { input.checked = false; });
                confirmRouteQueueButton.disabled = true;
                document.getElementById("route-queue-status").textContent = "";
                routeQueueOverlay.hidden = false;
                routeQueueAssistance.focus();
            }

            function updateAssistantRequirement() {
                const selectedRoutes = getSelectedRoutes().filter(route =>
                    getRoutesAvailableToActiveUser().includes(route));
                const required = !["assistant", "caseworker"].includes(activeUser?.role)
                    && selectedRoutes.some(route => getRouteQueueTags(route).includes(QUEUE_TAGS.assistencia));
                const assistantInput = form.querySelector("input[name='assistente']");
                if (assistantInput) assistantInput.required = required;
                document.getElementById("assistant-required").hidden = !required;
                document.getElementById("assistant-choices").setAttribute("aria-required", String(required));
                caseworkerAssignmentWrap.hidden = activeUser?.role === "caseworker"
                    || !selectedRoutes.some(route => getRouteQueueTags(route).includes(QUEUE_TAGS.cadastro));
            }

            function setRouteSelection(value) {
                const values = Array.isArray(value) ? value : value ? [value] : [];
                const availableRoutes = getRoutesAvailableToActiveUser();
                const selected = values.filter(route => availableRoutes.includes(route));
                routeCarousel.querySelectorAll("input[name='encaminhamento']").forEach(input => {
                    input.checked = selected.includes(input.value);
                });
                routeValue.value = JSON.stringify(selected);
                routeCurrent.textContent = selected.length ? selected.map(displayRouteName).join(", ") : "Escolha uma opção";
                routeCurrent.classList.toggle("placeholder", !selected.length);
                routeTrigger.setAttribute("aria-expanded", String(!routeOptions.hidden));
                updateAssistantRequirement();
            }

            function getSelectedRoutes() {
                try {
                    const selected = JSON.parse(routeValue.value || "[]");
                    return Array.isArray(selected) ? selected.filter(route => typeof route === "string" && routes.includes(route)) : [];
                } catch (error) {
                    console.error("Seleção de encaminhamentos inválida.", error);
                    return [];
                }
            }

            function closeRouteOptions() {
                routeOptions.hidden = true;
                routeTrigger.setAttribute("aria-expanded", "false");
                routeSearchInput.value = "";
                filterOptionCarousel(routeCarousel, routeSearchInput, routeSearchEmpty);
                window.setTimeout(() => routeTrigger.focus(), 0);
            }

            function renderRoutes() {
                const selected = getSelectedRoutes();
                routeCarousel.innerHTML = getRoutesAvailableToActiveUser().map((route, index) => {
                    const id = `route-option-${index}`;
                    const deleteButton = ["assistant", "caseworker"].includes(activeUser?.role)
                        ? ""
                        : `<button class="delete-route" type="button" data-route-index="${routes.indexOf(route)}" aria-label="Excluir encaminhamento ${escapeHtml(displayRouteName(route))}" title="Excluir encaminhamento"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 13h11l1-13M9 7V4h6v3"/></svg></button>`;
                    return `<div class="route-option"><input id="${id}" type="checkbox" name="encaminhamento" value="${escapeHtml(route)}" ${selected.includes(route) ? "checked" : ""}><label for="${id}">${escapeHtml(displayRouteName(route))}</label>${deleteButton}</div>`;
                }).join("");
                filterOptionCarousel(routeCarousel, routeSearchInput, routeSearchEmpty);
                setRouteSelection(selected);
                updateAssistantRequirement();
                routeCarousel.querySelectorAll("input[name='encaminhamento']").forEach(checkbox => {
                    checkbox.addEventListener("change", () => {
                        const nextSelection = getSelectedRoutes().filter(route => route !== checkbox.value);
                        if (checkbox.checked) nextSelection.push(checkbox.value);
                        setRouteSelection(nextSelection);
                    });
                });
                routeCarousel.querySelectorAll(".delete-route").forEach(button => {
                    button.addEventListener("click", async () => {
                        const index = Number(button.dataset.routeIndex);
                        const route = routes[index];
                        if (!window.confirm(`Excluir o encaminhamento “${displayRouteName(route)}”?`)) return;
                        const nextRoutes = routes.filter((_, routeIndex) => routeIndex !== index);
                        const nextRouteQueueTags = { ...routeQueueTags };
                        delete nextRouteQueueTags[route];
                        if (!await saveRouteConfiguration(nextRoutes, nextRouteQueueTags)) return;
                        setRouteSelection(getSelectedRoutes().filter(selectedRoute => selectedRoute !== route));
                        renderRoutes();
                        renderFilterOptions();
                    });
                });
                renderFilterOptions();
            }

            function setNationalitySelection(value) {
                const radio = Array.from(nationalityCarousel.querySelectorAll("input[name='nacionalidade']"))
                    .find(option => option.value === value);
                nationalityCarousel.querySelectorAll("input[name='nacionalidade']").forEach(option => {
                    option.checked = option === radio;
                });
                nationalityValue.value = radio ? radio.value : "";
                nationalityCurrent.textContent = radio && radio.value ? radio.value : "Opcional — escolha uma opção";
                nationalityCurrent.classList.toggle("placeholder", !radio || !radio.value);
            }

            function closeNationalityOptions() {
                nationalityOptions.hidden = true;
                nationalityTrigger.setAttribute("aria-expanded", "false");
                nationalitySearchInput.value = "";
                filterOptionCarousel(nationalityCarousel, nationalitySearchInput, nationalitySearchEmpty);
                window.setTimeout(() => nationalityTrigger.focus(), 0);
            }

            function renderNationalities() {
                const selected = nationalityValue.value;
                const options = nationalities.map((nationality, index) => {
                    const id = `nationality-option-${index}`;
                    return `<div class="route-option"><input id="${id}" type="radio" name="nacionalidade" value="${escapeHtml(nationality)}" ${nationality === selected ? "checked" : ""}><label for="${id}">${escapeHtml(nationality)}</label></div>`;
                }).join("");
                const emptyOption = `<div class="route-option"><input id="nationality-option-none" type="radio" name="nacionalidade" value="" ${!selected ? "checked" : ""}><label for="nationality-option-none">Não informada</label></div>`;
                nationalityCarousel.innerHTML = emptyOption + options;
                filterOptionCarousel(nationalityCarousel, nationalitySearchInput, nationalitySearchEmpty);
                nationalityCarousel.querySelectorAll("input[name='nacionalidade']").forEach(radio => {
                    radio.addEventListener("change", () => {
                        setNationalitySelection(radio.value);
                        closeNationalityOptions();
                    });
                    radio.addEventListener("click", closeNationalityOptions);
                });
                const filter = document.getElementById("filter-nationality");
                const filterSelected = filter.value;
                filter.innerHTML = `<option value="">Todas</option>${nationalities.map(nationality => `<option value="${escapeHtml(nationality)}">${escapeHtml(nationality)}</option>`).join("")}`;
                filter.value = filterSelected;
                setNationalitySelection(selected);
            }

            function renderFilterOptions() {
                const assistantFilter = document.getElementById("filter-assistant");
                const reportAssistantFilter = document.getElementById("report-assistant");
                const routeFilter = document.getElementById("filter-route");
                const assistantSelected = assistantFilter.value;
                const reportAssistantSelected = reportAssistantFilter.value;
                const routeSelected = routeFilter.value;
                const assistantOptions = users.filter(isTechnicalUser)
                    .map(user => `<option value="${escapeHtml(user.name)}">${escapeHtml(user.name)}</option>`).join("");
                assistantFilter.innerHTML = `<option value="">Todas</option>${assistantOptions}`;
                reportAssistantFilter.innerHTML = `<option value="">Todas</option>${assistantOptions}`;
                routeFilter.innerHTML = `<option value="">Todos</option>${routes.map(route => `<option value="${escapeHtml(route)}">${escapeHtml(displayRouteName(route))}</option>`).join("")}`;
                assistantFilter.value = assistantSelected;
                reportAssistantFilter.value = reportAssistantSelected;
                routeFilter.value = routeSelected;
            }

            function renderDashboard() {
                const today = dateKey(new Date());
                const todaysAppointments = appointments.filter(record => dateKey(record.createdAt) === today);
                document.getElementById("dashboard-date").textContent = new Intl.DateTimeFormat("pt-BR", { dateStyle: "full" }).format(new Date(`${today}T12:00:00`));
                const services = todaysAppointments.flatMap(record =>
                    getRecordServices(record).map(service => ({ record, service })));
                document.getElementById("total-count").textContent = String(services.length);
                const queueCounts = { done: 0, active: 0, waiting: 0 };
                services.forEach(({ service }) => {
                    const queueTypes = service.queueTags
                        .map(tag => tag === QUEUE_TAGS.cadastro ? "cadastro"
                            : tag === QUEUE_TAGS.assistencia ? "assistencia" : "")
                        .filter(Boolean);
                    if (!queueTypes.length) return;
                    const states = queueTypes.map(type => getServiceState(service, type));
                    if (states.every(state => state.finished === true)) queueCounts.done += 1;
                    else if (states.some(state => state.started === true && state.finished !== true)) queueCounts.active += 1;
                    else queueCounts.waiting += 1;
                });
                document.getElementById("queue-done-count").textContent = String(queueCounts.done);
                document.getElementById("queue-active-count").textContent = String(queueCounts.active);
                document.getElementById("queue-waiting-count").textContent = String(queueCounts.waiting);
                const dashboardUsers = users.filter(user =>
                    user.id !== SYSTEM_ADMIN_USER_ID
                    && user.role !== "reception" && user.role !== "intern" && user.role !== "caseworker");
                const counts = Object.fromEntries(dashboardUsers.map(user => [user.id, 0]));
                services.forEach(({ record, service }) => {
                    getCreditedMembers(service, record).forEach(member => {
                        if (Object.hasOwn(counts, member.id)) counts[member.id] += 1;
                    });
                });
                document.getElementById("assistant-stats").innerHTML = dashboardUsers.map(user =>
                    `<div class="assistant-stat" style="--assistant-color:${escapeHtml(user.color)}"><span>${escapeHtml(user.name)}</span><strong>${counts[user.id] || 0}</strong></div>`
                ).join("");
            }

            function hasQueueTag(record, tag) {
                return Array.isArray(record.tags) && record.tags.some(value =>
                    typeof value === "string" && value.trim().toLocaleLowerCase("pt-BR") === tag);
            }

            function userSnapshot(user) {
                return user ? {
                    id: user.id,
                    name: user.name,
                    role: user.role,
                    color: user.color,
                    ...(user.canAttendTechnical === true ? { canAttendTechnical: true } : {})
                } : null;
            }

            function getRecordServices(record) {
                if (Array.isArray(record.routeServices)) {
                    return record.routeServices.filter(service => service && typeof service.id === "string"
                        && typeof service.route === "string" && service.cancelled !== true)
                        .map(service => ({
                            ...service,
                            queueTags: Array.isArray(service.queueTags)
                                ? service.queueTags.filter(tag => Object.values(QUEUE_TAGS).includes(tag))
                                : getRouteQueueTags(service.route).filter(tag => tag !== QUEUE_TAG_NONE),
                            assignments: service.assignments && typeof service.assignments === "object"
                                ? service.assignments : {},
                            states: service.states && typeof service.states === "object" ? service.states : {},
                            collaborators: Array.isArray(service.collaborators) ? service.collaborators : []
                        }));
                }
                const legacyRoutes = Array.isArray(record.encaminhamentos) && record.encaminhamentos.length
                    ? record.encaminhamentos
                    : [record.encaminhamento || ""];
                return legacyRoutes.filter(Boolean).map((route, index) => {
                    const tags = getRouteQueueTags(route).filter(tag => tag !== QUEUE_TAG_NONE);
                    const states = {};
                    tags.forEach(tag => {
                        const queueType = tag === QUEUE_TAGS.cadastro ? "cadastro" : "assistencia";
                        const started = queueType === "cadastro"
                            ? record.cadastroUnicoIniciada === true
                            : record.assistenciaIniciada === true;
                        const finished = queueType === "cadastro"
                            ? record.cadastroUnicoFinalizado === true
                            : record.assistenciaFinalizada === true;
                        states[queueType] = {
                            started,
                            finished,
                            enteredAt: queueEntryTimestamp(record, queueType) || record.createdAt,
                            startedAt: queueType === "cadastro"
                                ? record.cadastroUnicoIniciadaEm || ""
                                : record.assistenciaIniciadaEm || "",
                            finishedAt: ""
                        };
                    });
                    return {
                        id: `legacy-${record.id}-${index}`,
                        route,
                        queueTags: tags,
                        assignments: {
                            assistencia: assistants.find(user => user.name === record.assistente)
                                ? userSnapshot(users.find(user => user.name === record.assistente && isTechnicalUser(user)))
                                : record.assistente ? { id: "", name: record.assistente, role: "assistant", color: "" } : null
                        },
                        startedBy: null,
                        collaborators: [],
                        states
                    };
                });
            }

            function getAppointmentAnnotations(record) {
                const annotations = record?.annotations;
                return annotations && typeof annotations === "object" && !Array.isArray(annotations)
                    ? annotations : { assistencia: [], cadastro: [] };
            }

            function getAnnotationEntries(record, category) {
                const entries = getAppointmentAnnotations(record)[category];
                return Array.isArray(entries)
                    ? entries.filter(entry => entry && typeof entry === "object" && typeof entry.id === "string")
                    : [];
            }

            function getVisibleAnnotationCategories() {
                if (activeUser?.role === "admin") return ["cadastro"];
                if (activeUser?.role === "assistant") return ["assistencia"];
                if (activeUser?.role === "caseworker") return ["cadastro"];
                return [];
            }

            function visibleAnnotationCount(record) {
                return getVisibleAnnotationCategories().reduce(
                    (total, category) => total + getAnnotationEntries(record, category).length,
                    0
                );
            }

            function annotationActionLabel(record) {
                return visibleAnnotationCount(record) ? "Editar anotações" : "Anotar";
            }

            function personNameKey(name) {
                return String(name || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
            }

            function createPersonKey() {
                return window.crypto?.randomUUID
                    ? window.crypto.randomUUID()
                    : `person-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            }

            function resolvePersonForAppointment(record, currentRecord) {
                if (currentRecord?.personKey) {
                    const existing = people.find(person => person.key === currentRecord.personKey);
                    return existing ? { person: existing, isNew: false } : {
                        person: {
                            key: currentRecord.personKey,
                            id: Number.isSafeInteger(currentRecord.personId) ? currentRecord.personId : null,
                            name: record.nome,
                            cpf: record.cpf,
                            createdAt: record.createdAt
                        },
                        isNew: true
                    };
                }
                const cpf = String(record.cpf || "").replace(/\D/g, "");
                const nameKey = personNameKey(record.nome);
                const matchingPeople = cpf.length === 11
                    ? people.filter(person => String(person.cpf || "").replace(/\D/g, "") === cpf
                        && personNameKey(person.name) === nameKey)
                    : [];
                if (matchingPeople.length === 1) return { person: matchingPeople[0], isNew: false };
                if (matchingPeople.length > 1) {
                    return {
                        person: matchingPeople.sort((left, right) => (left.id || Infinity) - (right.id || Infinity))[0],
                        isNew: false
                    };
                }
                const matchingAppointment = cpf.length === 11
                    ? appointments.find(item => String(item.cpf || "").replace(/\D/g, "") === cpf
                        && personNameKey(item.nome) === nameKey && item.personKey)
                    : null;
                if (matchingAppointment) {
                    const existing = people.find(person => person.key === matchingAppointment.personKey);
                    if (existing) return { person: existing, isNew: false };
                    const restored = {
                        key: matchingAppointment.personKey,
                        id: Number.isSafeInteger(matchingAppointment.personId) ? matchingAppointment.personId : null,
                        name: matchingAppointment.nome,
                        cpf,
                        createdAt: matchingAppointment.createdAt
                    };
                    return { person: restored, isNew: true };
                }
                return {
                    person: {
                        key: createPersonKey(),
                        id: null,
                        name: record.nome,
                        cpf,
                        createdAt: record.createdAt
                    },
                    isNew: true
                };
            }

            function personIdForRecord(record) {
                const person = people.find(item => item.key === record?.personKey);
                const id = person ? person.id : record?.personId;
                return Number.isSafeInteger(id) && id > 0 ? String(id) : "Pendente";
            }

            function isAppointmentAssignedToActiveUser(record, queueType) {
                if (!activeUser) return false;
                const assignmentField = queueType === "assistencia" ? "assistente" : "cadastradora";
                const activeName = String(activeUser.name || "").trim().toLocaleLowerCase("pt-BR");
                const recordName = String(record[assignmentField] || "").trim().toLocaleLowerCase("pt-BR");
                return getRecordServices(record).some(service => {
                    const assignment = service.assignments?.[queueType];
                    return Boolean(assignment && (
                        activeUser.id && assignment.id === activeUser.id
                        || activeName && String(assignment.name || "").trim().toLocaleLowerCase("pt-BR") === activeName
                    ));
                }) || Boolean(activeName && recordName === activeName);
            }

            function canEditAppointmentAnnotations(record) {
                if (activeUser?.role === "admin") return true;
                if (activeUser?.role === "assistant") {
                    return isAppointmentAssignedToActiveUser(record, "assistencia");
                }
                if (activeUser?.role === "caseworker") {
                    return isAppointmentAssignedToActiveUser(record, "cadastro");
                }
                return false;
            }

            function getServiceState(service, queueType) {
                const existing = service.states?.[queueType];
                return existing && typeof existing === "object"
                    ? existing
                    : { started: false, finished: false, enteredAt: "", startedAt: "", finishedAt: "" };
            }

            function queueTypeTag(queueType) {
                return queueType === "cadastro" ? QUEUE_TAGS.cadastro : QUEUE_TAGS.assistencia;
            }

            function queueAssigneeOptions(queueType, selectedId) {
                const eligibleUsers = queueType === "cadastro"
                    ? users.filter(user => user.role === "caseworker")
                    : users.filter(isTechnicalUser);
                return eligibleUsers.map(user =>
                    `<option value="${escapeHtml(user.id)}" ${user.id === selectedId ? "selected" : ""}>${escapeHtml(user.name)}</option>`
                ).join("");
            }

            function elapsedQueueTime(timestamp) {
                const startedAt = Date.parse(timestamp || "");
                if (!Number.isFinite(startedAt)) return "";
                const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60000));
                if (minutes < 60) return `${minutes} min`;
                return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
            }

            function queueCardMarkup(record, service, queueType) {
                const state = getServiceState(service, queueType);
                const started = state.started === true;
                const enteredAt = state.enteredAt || record.createdAt;
                const timestamp = started ? state.startedAt || enteredAt : enteredAt;
                const elapsed = elapsedQueueTime(timestamp);
                const overdue = !started && Date.now() - Date.parse(enteredAt) >= QUEUE_PROMPT_DELAY[queueType];
                const assignee = service.assignments?.[queueType];
                const assigneeName = assignee?.name || "Responsável não definido";
                const routeOptions = routes.filter(route => getRouteQueueTags(route).includes(queueTypeTag(queueType)))
                    .map(route => `<option value="${escapeHtml(route)}" ${route === service.route ? "selected" : ""}>${escapeHtml(displayRouteName(route))}</option>`)
                    .join("");
                const collaborators = Array.isArray(service.collaborators) ? service.collaborators : [];
                const acquiredBy = queueType === "assistencia" ? service.assistanceAcquiredBy : null;
                const teamOptions = users.filter(user => queueType === "cadastro"
                    ? user.role === "caseworker" : isTechnicalUser(user))
                    .map(user => `<option value="${escapeHtml(user.id)}" ${collaborators.some(member => member.id === user.id) ? "selected" : ""}>${escapeHtml(user.name)}</option>`)
                    .join("");
                const creditedNames = [service.startedBy?.name, ...collaborators.map(member => member.name)]
                    .filter(Boolean).filter((name, index, list) => list.indexOf(name) === index);
                const folderAction = acquiredBy?.id === activeUser?.id
                    ? `<button class="button-secondary" type="button" data-folder-action="release" data-record-id="${escapeHtml(record.id)}" data-service-id="${escapeHtml(service.id)}">Devolver pasta</button>`
                    : !acquiredBy && queueType === "assistencia" && activeUser?.role === "intern" && !started
                        ? `<button class="button-primary" type="button" data-folder-action="acquire" data-record-id="${escapeHtml(record.id)}" data-service-id="${escapeHtml(service.id)}">Adquirir pasta</button>`
                        : "";
                const annotationsAction = canEditAppointmentAnnotations(record)
                    ? `<button class="button-secondary" type="button" data-annotation-record="${escapeHtml(record.id)}">${annotationActionLabel(record)}</button>`
                    : "";
                return `<article class="queue-card ${queueType === "assistencia" ? "assistance-card" : ""}" style="--assistant-color:${escapeHtml(assignee?.color || "#6f8dba")}">
                    <div class="queue-card-heading"><strong>${escapeHtml(record.nome || "Sem nome")}<span class="person-id-label">ID da pessoa: ${escapeHtml(personIdForRecord(record))}</span></strong><span class="queue-status">${started ? "Em atendimento" : "Aguardando"}</span></div>
                    <p class="queue-meta">${escapeHtml(displayRouteName(service.route))} · ${escapeHtml(assigneeName)} · ${started ? "Iniciado" : "Na fila"} às ${escapeHtml(formatDateTime(timestamp))}</p>
                    <p class="queue-meta queue-elapsed ${overdue ? "is-overdue" : ""}">${started ? "Em atendimento há" : "Aguardando há"} ${escapeHtml(elapsed || "tempo indisponível")}${overdue ? " · acima do tempo de aviso" : ""}</p>
                    ${acquiredBy ? `<p class="queue-meta">Pasta adquirida por ${escapeHtml(acquiredBy.name || "Estagiário")}${service.assistanceAcquiredAt ? ` às ${escapeHtml(formatDateTime(service.assistanceAcquiredAt))}` : ""}</p>` : ""}
                    ${service.startedBy ? `<p class="queue-meta">Iniciado por: ${escapeHtml(service.startedBy.name)}${creditedNames.length > 1 ? ` · Equipe: ${escapeHtml(creditedNames.join(", "))}` : ""}</p>` : ""}
                    <div class="queue-actions"><button class="queue-action" type="button" data-queue-action="${started ? "finish" : "start"}" data-queue-type="${queueType}" data-record-id="${escapeHtml(record.id)}" data-service-id="${escapeHtml(service.id)}">${started ? "Finalizar atendimento" : "Iniciar atendimento"}</button>${annotationsAction}${!started && ["reception", "intern"].includes(activeUser?.role) ? `<button class="button-secondary" type="button" data-queue-action="finish" data-queue-type="${queueType}" data-record-id="${escapeHtml(record.id)}" data-service-id="${escapeHtml(service.id)}">Finalizar fila</button>` : ""}${folderAction}</div>
                    <details class="queue-transfer">
                        <summary>Alterar encaminhamento ou equipe</summary>
                        <label class="field-label">Encaminhamento<select class="select-input" data-transfer-route>${routeOptions}</select></label>
                        <label class="field-label">Encaminhar para<select class="select-input" data-transfer-assignee><option value="">Não definida</option>${queueAssigneeOptions(queueType, assignee?.id || "")}</select></label>
                        <button class="button-secondary" type="button" data-save-transfer data-record-id="${escapeHtml(record.id)}" data-service-id="${escapeHtml(service.id)}" data-queue-type="${queueType}">Salvar encaminhamento</button>
                        <label class="field-label">Colaboradores<select class="select-input" data-team-select multiple size="3">${teamOptions}</select></label>
                        <button class="button-secondary" type="button" data-save-team data-record-id="${escapeHtml(record.id)}" data-service-id="${escapeHtml(service.id)}" data-queue-type="${queueType}">Salvar equipe</button>
                    </details>
                </article>`;
            }

            function queueEntryTimestamp(record, queueType) {
                return queueType === "cadastro"
                    ? record.cadastroUnicoNaFilaDesde || record.queueEnteredAt
                    : record.assistenciaNaFilaDesde || record.queueEnteredAt;
            }

            function renderQueues() {
                const today = dateKey(new Date());
                const getEntries = queueType => appointments.filter(record => dateKey(record.createdAt) === today)
                    .flatMap(record => getRecordServices(record)
                        .filter(service => service.queueTags.includes(queueTypeTag(queueType))
                            && getServiceState(service, queueType).finished !== true)
                        .map(service => ({ record, service })));
                const byOldestFirst = entries => entries.sort((left, right) =>
                    Date.parse(getServiceState(left.service, left.queueType).enteredAt || left.record.createdAt)
                    - Date.parse(getServiceState(right.service, right.queueType).enteredAt || right.record.createdAt));
                const cadastroEntries = getEntries("cadastro").map(entry => ({ ...entry, queueType: "cadastro" }));
                const assistanceEntries = getEntries("assistencia").map(entry => ({ ...entry, queueType: "assistencia" }));
                byOldestFirst(cadastroEntries);
                byOldestFirst(assistanceEntries);
                const role = activeUser?.role;
                const mobileIntern = mobileClient && role === "intern";
                const canSeeCadastro = !mobileIntern
                    && (role === "admin" || role === "reception" || role === "intern" || role === "caseworker");
                const canSeeAssistance = role === "admin" || role === "reception" || role === "intern" || role === "assistant";
                const cadastroList = document.getElementById("cadastro-queue-list");
                const assistanceList = document.getElementById("assistance-queue-list");
                const cadastroDashboard = cadastroList.closest(".queue-dashboard");
                const assistanceDashboard = assistanceList.closest(".queue-dashboard");
                cadastroDashboard.dataset.roleVisible = String(canSeeCadastro);
                assistanceDashboard.dataset.roleVisible = String(canSeeAssistance);
                const cadastroVisible = canSeeCadastro && dashboardLayout.visible.includes("cadastro-queue");
                const assistanceVisible = canSeeAssistance && dashboardLayout.visible.includes("assistance-queue");
                queueDashboards.classList.toggle("single-queue", cadastroVisible !== assistanceVisible);
                document.getElementById("cadastro-queue-count").textContent = String(cadastroEntries.length);
                document.getElementById("assistance-queue-count").textContent = String(assistanceEntries.length);
                cadastroList.innerHTML = cadastroEntries.length
                    ? cadastroEntries.map(({ record, service }) => queueCardMarkup(record, service, "cadastro")).join("")
                    : `<div class="queue-empty">Não há pessoas aguardando nesta fila.</div>`;
                assistanceList.innerHTML = assistanceEntries.length
                    ? assistanceEntries.map(({ record, service }) => queueCardMarkup(record, service, "assistencia")).join("")
                    : `<div class="queue-empty">Não há pessoas aguardando nesta fila.</div>`;
                applyDashboardLayout();
            }

            async function updateQueueService(recordId, serviceId, mutateService) {
                const record = appointments.find(item => item.id === recordId);
                if (!record) {
                    showToast("Não foi possível localizar o atendimento nesta fila.");
                    return false;
                }
                const services = getRecordServices(record).map(service =>
                    service.id === serviceId ? mutateService({ ...service, states: { ...service.states } }) : service);
                const updatedRecord = {
                    ...record,
                    routeServices: services,
                    encaminhamentos: services.map(service => service.route),
                    encaminhamento: services.map(service => service.route).join(", "),
                    tags: [...new Set(services.flatMap(service => service.queueTags))]
                };
                const updatedAppointments = appointments.map(item => item.id === recordId ? updatedRecord : item);
                if (!await saveStorage(STORAGE_RECORDS, updatedAppointments)) return false;
                appointments = updatedAppointments;
                if (mobileClient && mobileAccessKey) {
                    window.clearTimeout(localSnapshotPersistTimer);
                    if (mobileOfflineMode || !navigator.onLine) {
                        mobileOfflineMode = true;
                        mobilePendingSync = true;
                        updateSyncIndicator();
                        showSyncStatus("A alteração foi salva neste celular e será sincronizada quando o servidor voltar.", 0);
                    } else {
                        try {
                            await persistMobileSnapshotToServer(createSyncSnapshot(), activeUser?.role);
                        } catch (error) {
                            mobileOfflineMode = true;
                            mobilePendingSync = true;
                            document.querySelector(".offline").textContent = "Modo offline · alterações salvas neste celular";
                            updateSyncIndicator();
                            console.error("Não foi possível enviar a ação da fila ao servidor.", error);
                            showSyncStatus(`A alteração foi salva neste celular; sincronização pendente: ${error.message}`, 0);
                        }
                    }
                }
                renderAll();
                return true;
            }

            async function handleQueueAction(event) {
                const action = event.target.closest("[data-queue-action]");
                const folderAction = event.target.closest("[data-folder-action]");
                const transfer = event.target.closest("[data-save-transfer]");
                const saveTeam = event.target.closest("[data-save-team]");
                if (!activeUser) return;
                if (folderAction) {
                    if (activeUser.role !== "intern") {
                        showToast("Somente o perfil Estagiário pode adquirir ou devolver a pasta.");
                        return;
                    }
                    const { folderAction: actionType, recordId, serviceId } = folderAction.dataset;
                    const record = appointments.find(item => item.id === recordId);
                    const currentService = record && getRecordServices(record).find(item => item.id === serviceId);
                    if (!record || !currentService || !currentService.queueTags.includes(QUEUE_TAGS.assistencia)) {
                        showToast("Não foi possível localizar a pasta na fila do Atendimento Técnico.");
                        return;
                    }
                    const state = getServiceState(currentService, "assistencia");
                    if (actionType === "acquire"
                        && (state.started === true || state.finished === true
                            || currentService.assistanceAcquiredBy?.id)) {
                        showToast("Esta pasta já foi iniciada ou adquirida por outra pessoa.");
                        return;
                    }
                    if (actionType === "release" && currentService.assistanceAcquiredBy?.id !== activeUser.id) {
                        showToast("Você só pode devolver uma pasta adquirida por você.");
                        return;
                    }
                    let acquisitionConflict = false;
                    const saved = await updateQueueService(recordId, serviceId, service => {
                        if (actionType === "acquire") {
                            if (service.assistanceAcquiredBy?.id && service.assistanceAcquiredBy.id !== activeUser.id) {
                                acquisitionConflict = true;
                                return service;
                            }
                            service.assistanceAcquiredBy = userSnapshot(activeUser);
                            service.assistanceAcquiredAt = new Date().toISOString();
                        } else {
                            delete service.assistanceAcquiredBy;
                            delete service.assistanceAcquiredAt;
                        }
                        return service;
                    });
                    const latestRecord = appointments.find(item => item.id === recordId);
                    const latestService = latestRecord && getRecordServices(latestRecord)
                        .find(item => item.id === serviceId);
                    const acquisitionWasLost = actionType === "acquire"
                        && latestService?.assistanceAcquiredBy?.id !== activeUser.id;
                    if (saved && (acquisitionConflict || acquisitionWasLost)) {
                        showToast("Outra pessoa adquiriu esta pasta antes de você.");
                    } else if (saved) {
                        showToast(actionType === "acquire" ? "Pasta adquirida." : "Pasta devolvida à fila.");
                    }
                    return;
                }
                if (action) {
                    const { queueAction, queueType, recordId, serviceId } = action.dataset;
                    if (activeUser?.role === "assistant" && queueType !== "assistencia"
                        || activeUser?.role === "caseworker" && queueType !== "cadastro") {
                        showToast("Seu perfil não tem permissão para alterar esta fila.");
                        return;
                    }
                    await updateQueueService(recordId, serviceId, service => {
                        const state = { ...getServiceState(service, queueType) };
                        const now = new Date().toISOString();
                        if (queueAction === "start") {
                            state.started = true;
                            state.startedAt = state.startedAt || now;
                            state.enteredAt = state.enteredAt || now;
                            service.startedBy = service.startedBy || userSnapshot(activeUser);
                        } else {
                            state.finished = true;
                            state.finishedAt = now;
                            if (activeUser.role === "reception") {
                                state.finishedBy = userSnapshot(activeUser);
                                delete state.finishedFollowupAt;
                                delete state.attendedBy;
                            } else {
                                delete state.finishedBy;
                                delete state.finishedFollowupAt;
                            }
                        }
                        service.states[queueType] = state;
                        return service;
                    });
                    return;
                }
                if (transfer) {
                    const { recordId, serviceId, queueType } = transfer.dataset;
                    if (activeUser?.role === "assistant" && queueType !== "assistencia"
                        || activeUser?.role === "caseworker" && queueType !== "cadastro") {
                        showToast("Seu perfil não tem permissão para alterar esta fila.");
                        return;
                    }
                    const card = transfer.closest(".queue-card");
                    const nextRoute = card.querySelector("[data-transfer-route]").value;
                    const nextUser = users.find(user => user.id === card.querySelector("[data-transfer-assignee]").value);
                    await updateQueueService(recordId, serviceId, service => {
                        service.route = nextRoute;
                        service.queueTags = getRouteQueueTags(nextRoute).filter(tag => tag !== QUEUE_TAG_NONE);
                        service.queueTags.forEach(tag => {
                            const targetQueue = tag === QUEUE_TAGS.cadastro ? "cadastro" : "assistencia";
                            if (!service.states[targetQueue]) {
                                service.states[targetQueue] = {
                                    started: false,
                                    finished: false,
                                    enteredAt: new Date().toISOString(),
                                    startedAt: "",
                                    finishedAt: ""
                                };
                            }
                        });
                        service.assignments = { ...(service.assignments || {}) };
                        service.assignments[queueType] = userSnapshot(nextUser);
                        return service;
                    });
                    return;
                }
                if (saveTeam) {
                    const { recordId, serviceId, queueType } = saveTeam.dataset;
                    if (activeUser.role === "assistant" && queueType !== "assistencia"
                        || activeUser.role === "caseworker" && queueType !== "cadastro") {
                        showToast("Seu perfil não tem permissão para alterar esta fila.");
                        return;
                    }
                    const card = saveTeam.closest(".queue-card");
                    const selectedIds = Array.from(card.querySelector("[data-team-select]").selectedOptions)
                        .map(option => option.value);
                    const collaborators = users.filter(user => selectedIds.includes(user.id)).map(userSnapshot);
                    await updateQueueService(recordId, serviceId, service => ({ ...service, collaborators }));
                }
            }

            async function ensureQueueTimestamps() {
                const now = new Date().toISOString();
                let changed = false;
                const updatedAppointments = appointments.map(record => {
                    if (dateKey(record.createdAt) !== dateKey(new Date())) return record;
                    const hasActiveQueue = (hasQueueTag(record, QUEUE_TAGS.cadastro) && record.cadastroUnicoFinalizado !== true)
                        || (hasQueueTag(record, QUEUE_TAGS.assistencia) && record.assistenciaFinalizada !== true);
                    if (!hasActiveQueue) return record;
                    const updatedRecord = { ...record };
                    if (!Number.isFinite(Date.parse(updatedRecord.queueEnteredAt || ""))) {
                        updatedRecord.queueEnteredAt = [
                            updatedRecord.cadastroUnicoNaFilaDesde,
                            updatedRecord.assistenciaNaFilaDesde
                        ].find(timestamp => Number.isFinite(Date.parse(timestamp || ""))) || now;
                    }
                    if (hasQueueTag(record, QUEUE_TAGS.cadastro)
                        && record.cadastroUnicoFinalizado !== true
                        && !Number.isFinite(Date.parse(updatedRecord.cadastroUnicoNaFilaDesde || ""))) {
                        updatedRecord.cadastroUnicoNaFilaDesde = updatedRecord.queueEnteredAt;
                    }
                    if (hasQueueTag(record, QUEUE_TAGS.cadastro)
                        && record.cadastroUnicoIniciada === true
                        && !Number.isFinite(Date.parse(updatedRecord.cadastroUnicoIniciadaEm || ""))) {
                        updatedRecord.cadastroUnicoIniciadaEm = now;
                    }
                    if (hasQueueTag(record, QUEUE_TAGS.assistencia)
                        && record.assistenciaFinalizada !== true
                        && !Number.isFinite(Date.parse(updatedRecord.assistenciaNaFilaDesde || ""))) {
                        updatedRecord.assistenciaNaFilaDesde = updatedRecord.queueEnteredAt;
                    }
                    if (hasQueueTag(record, QUEUE_TAGS.assistencia)
                        && record.assistenciaFinalizada !== true
                        && record.assistenciaIniciada === true
                        && !Number.isFinite(Date.parse(updatedRecord.assistenciaIniciadaEm || ""))) {
                        updatedRecord.assistenciaIniciadaEm = now;
                    }
                    if (updatedRecord.queueEnteredAt === record.queueEnteredAt
                        && updatedRecord.cadastroUnicoNaFilaDesde === record.cadastroUnicoNaFilaDesde
                        && updatedRecord.cadastroUnicoIniciadaEm === record.cadastroUnicoIniciadaEm
                        && updatedRecord.assistenciaNaFilaDesde === record.assistenciaNaFilaDesde
                        && updatedRecord.assistenciaIniciadaEm === record.assistenciaIniciadaEm) return record;
                    changed = true;
                    return updatedRecord;
                });
                if (!changed) return true;
                if (!await saveStorage(STORAGE_RECORDS, updatedAppointments)) return false;
                appointments = updatedAppointments;
                renderAll();
                return true;
            }

            function openQueuePrompt(prompt) {
                const record = appointments.find(item => item.id === prompt.recordId);
                if (!record) return;
                const service = getRecordServices(record).find(item => item.id === prompt.serviceId);
                if (!service) return;
                pendingQueuePrompt = prompt;
                queuePromptReturnFocus = document.activeElement;
                const queueName = prompt.type === "cadastro" ? "Cadastro Único" : "Atendimento Técnico";
                const waitMinutes = prompt.type === "cadastro" ? 25 : 15;
                const status = getServiceState(service, prompt.type).started === true
                    ? "está em atendimento"
                    : "aguarda";
                queueFollowupMessage.textContent = prompt.receptionFinished
                    ? `A Recepção finalizou a fila de ${queueName} para ${record.nome || "a pessoa"} · ${displayRouteName(service.route)}. A pessoa foi atendida?`
                    : `${record.nome || "A pessoa"} · ${displayRouteName(service.route)} ${status} há mais de ${waitMinutes} minutos na fila de ${queueName}. A pessoa foi atendida?`;
                queueFollowupOverlay.hidden = false;
                queueFollowupYes.focus();
            }

            async function answerQueuePrompt(attended) {
                if (!pendingQueuePrompt) return;
                const prompt = pendingQueuePrompt;
                const record = appointments.find(item => item.id === prompt.recordId);
                if (!record) {
                    queueFollowupOverlay.hidden = true;
                    pendingQueuePrompt = null;
                    return;
                }
                queueFollowupNo.disabled = true;
                queueFollowupYes.disabled = true;
                const saved = await updateQueueService(record.id, prompt.serviceId, service => {
                    const state = { ...getServiceState(service, prompt.type) };
                    if (attended) {
                        state.finished = true;
                        state.finishedAt = new Date().toISOString();
                        if (prompt.receptionFinished) {
                            state.finishedFollowupAt = new Date().toISOString();
                            if (prompt.type === "assistencia") state.attendedBy = userSnapshot(activeUser);
                        }
                    } else if (prompt.receptionFinished) {
                        state.finished = false;
                        delete state.finishedAt;
                        delete state.finishedBy;
                        delete state.finishedFollowupAt;
                        delete state.attendedBy;
                        state.reminderAt = new Date().toISOString();
                    } else {
                        state.reminderAt = new Date().toISOString();
                    }
                    service.states[prompt.type] = state;
                    return service;
                });
                queueFollowupNo.disabled = false;
                queueFollowupYes.disabled = false;
                if (!saved) return;
                queueFollowupOverlay.hidden = true;
                pendingQueuePrompt = null;
                if (queuePromptReturnFocus?.isConnected) queuePromptReturnFocus.focus();
                queuePromptReturnFocus = null;
                await processQueueTimers();
            }

            function shouldShowQueuePrompt(type, service, user) {
                if (type === "cadastro") return user?.role === "caseworker";
                return type === "assistencia"
                    && isTechnicalUser(user)
                    && Boolean(user.id)
                    && service.assignments?.assistencia?.id === user.id;
            }

            function shouldShowReceptionFinishedPrompt(type, service, user, state) {
                if (state.finished !== true || state.finishedFollowupAt
                    || state.finishedBy?.role !== "reception") return false;
                const assignee = service.assignments?.[type];
                if (!assignee?.id || assignee.id !== user?.id) return false;
                return type === "cadastro"
                    ? user.role === "caseworker"
                    : type === "assistencia" && isTechnicalUser(user);
            }

            async function processQueueTimers() {
                if (queueTimerRunning) return;
                queueTimerRunning = true;
                try {
                    const now = Date.now();
                    const today = dateKey(new Date(now));
                    const expiredAssistance = appointments.flatMap(record => getRecordServices(record)
                        .filter(service => dateKey(record.createdAt) === today
                            && service.queueTags.includes(QUEUE_TAGS.assistencia))
                        .filter(service => {
                            const state = getServiceState(service, "assistencia");
                            const startedAt = Date.parse(state.startedAt || state.enteredAt || "");
                            return state.started === true && state.finished !== true
                                && Number.isFinite(startedAt) && now - startedAt >= ASSISTANCE_DURATION;
                        })
                        .map(service => ({ recordId: record.id, serviceId: service.id })));
                    for (const { recordId, serviceId } of expiredAssistance) {
                        await updateQueueService(recordId, serviceId, service => {
                            const state = { ...getServiceState(service, "assistencia"), finished: true, finishedAt: new Date().toISOString() };
                            service.states.assistencia = state;
                            return service;
                        });
                    }

                    if (!queueFollowupOverlay.hidden || now - lastFormActivityAt < FORM_IDLE_DELAY) return;
                    const duePrompts = appointments.flatMap(record => getRecordServices(record)
                        .filter(service => dateKey(record.createdAt) === today)
                        .flatMap(service => service.queueTags.map(tag => {
                            const type = tag === QUEUE_TAGS.cadastro ? "cadastro"
                                : tag === QUEUE_TAGS.assistencia ? "assistencia" : "";
                            if (!type) return null;
                            const state = getServiceState(service, type);
                            if (state.finished === true) {
                                return shouldShowReceptionFinishedPrompt(type, service, activeUser, state)
                                    ? {
                                        type,
                                        recordId: record.id,
                                        serviceId: service.id,
                                        dueAt: Date.parse(state.finishedAt || "") || now,
                                        receptionFinished: true
                                    }
                                    : null;
                            }
                            const baseTime = Date.parse(state.started === true
                                ? state.startedAt || state.enteredAt
                                : state.enteredAt);
                            if (!Number.isFinite(baseTime)) return null;
                            const reminderAt = Date.parse(state.reminderAt || "") || baseTime;
                            const delay = QUEUE_PROMPT_DELAY[type];
                            return now - reminderAt >= delay && shouldShowQueuePrompt(type, service, activeUser)
                                ? { type, recordId: record.id, serviceId: service.id, dueAt: reminderAt + delay }
                                : null;
                        }).filter(Boolean)));
                    duePrompts.sort((left, right) => left.dueAt - right.dueAt);
                    if (duePrompts.length) openQueuePrompt(duePrompts[0]);
                } finally {
                    queueTimerRunning = false;
                }
            }

            ["cadastro-queue-list", "assistance-queue-list"].forEach(queueId => {
                document.getElementById(queueId).addEventListener("click", event => {
                    handleQueueAction(event).catch(error => {
                        console.error("Falha ao atualizar o serviço da fila.", error);
                        showToast("Não foi possível atualizar o atendimento.");
                    });
                });
            });
            document.addEventListener("click", event => {
                const button = event.target.closest("[data-annotation-record]");
                if (!button) return;
                const record = appointments.find(item => item.id === button.dataset.annotationRecord);
                if (record) openAppointmentAnnotations(record, button);
            });
            appointmentAnnotationsCategories.addEventListener("input", event => {
                const field = event.target;
                if (!(field instanceof HTMLTextAreaElement) || field.dataset.annotationNew !== "true"
                    || !field.value.trim()) return;
                const category = field.dataset.annotationCategory;
                const container = appointmentAnnotationsCategories.querySelector(`[data-annotation-list="${category}"]`);
                if (!container) return;
                const hasEmptyField = [...container.querySelectorAll('[data-annotation-new="true"]')]
                    .some(candidate => candidate !== field && !candidate.value.trim());
                if (!hasEmptyField) appendBlankAnnotationEntry(category);
            });
            appointmentAnnotationsForm.addEventListener("submit", event => {
                event.preventDefault();
                saveAppointmentAnnotations().catch(error => {
                    console.error("Não foi possível salvar as anotações do atendimento.", error);
                    appointmentAnnotationsStatus.textContent = "Não foi possível salvar as anotações. Tente novamente.";
                    showToast("Não foi possível salvar as anotações.");
                });
            });
            appointmentAnnotationsCancel.addEventListener("click", () => closeAppointmentAnnotations());
            appointmentAnnotationsOverlay.addEventListener("click", event => {
                if (event.target === appointmentAnnotationsOverlay) closeAppointmentAnnotations();
            });
            document.addEventListener("keydown", event => {
                if (appointmentAnnotationsOverlay.hidden) return;
                if (event.key === "Escape") {
                    closeAppointmentAnnotations();
                    return;
                }
                if (event.key !== "Tab") return;
                const focusable = [...appointmentAnnotationsOverlay.querySelectorAll(
                    "textarea:not([disabled]), button:not([disabled])"
                )].filter(element => element.getClientRects().length);
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            });

            function getFilteredAppointments() {
                const filters = {
                    quickSearch: normalizeSearchValue(document.getElementById("history-quick-search").value),
                    date: document.getElementById("filter-date").value,
                    nome: document.getElementById("filter-name").value.trim().toLocaleLowerCase("pt-BR"),
                    endereco: document.getElementById("filter-address").value.trim().toLocaleLowerCase("pt-BR"),
                    cpf: document.getElementById("filter-cpf").value.replace(/\D/g, ""),
                    telefone: document.getElementById("filter-phone").value.replace(/\D/g, ""),
                    nacionalidade: document.getElementById("filter-nationality").value,
                    assistente: document.getElementById("filter-assistant").value,
                    encaminhamento: document.getElementById("filter-route").value
                };
                return [...appointments].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                    .flatMap(getServiceRows).filter(record => {
                    const quickSearchText = normalizeSearchValue([
                        record.nome,
                        record.cpf,
                        record.telefone,
                        formattedAddress(record),
                        record.nacionalidade ?? record.etnia,
                        record.assistente,
                        record.encaminhamento,
                        ...record.serviceMembers.map(member => member.name)
                    ].join(" "));
                    const quickSearchDigits = filters.quickSearch.replace(/\D/g, "");
                    const quickSearchMatches = !filters.quickSearch
                        || quickSearchText.includes(filters.quickSearch)
                        || Boolean(quickSearchDigits && `${record.cpf || ""}${record.telefone || ""}`
                            .replace(/\D/g, "").includes(quickSearchDigits));
                    return quickSearchMatches
                        && (!filters.date || dateKey(record.createdAt) === filters.date)
                        && (!filters.nome || (record.nome || "").toLocaleLowerCase("pt-BR").includes(filters.nome))
                        && (!filters.endereco || formattedAddress(record).toLocaleLowerCase("pt-BR").includes(filters.endereco))
                        && (!filters.cpf || (record.cpf || "").replace(/\D/g, "").includes(filters.cpf))
                        && (!filters.telefone || (record.telefone || "").replace(/\D/g, "").includes(filters.telefone))
                        && (!filters.nacionalidade || (record.nacionalidade ?? record.etnia ?? "") === filters.nacionalidade)
                        && (!filters.assistente || record.serviceMembers.some(member => member.name === filters.assistente))
                        && (!filters.encaminhamento || record.encaminhamento === filters.encaminhamento);
                });
            }

            function normalizeSearchValue(value) {
                return String(value ?? "")
                    .normalize("NFD")
                    .replace(/\p{Diacritic}/gu, "")
                    .toLocaleLowerCase("pt-BR");
            }

            const HISTORY_FILTER_FIELDS = [
                "history-quick-search", "filter-date", "filter-name", "filter-address", "filter-cpf",
                "filter-phone", "filter-nationality", "filter-assistant", "filter-route"
            ];

            function getCurrentHistoryFilterValues() {
                return Object.fromEntries(HISTORY_FILTER_FIELDS.map(id =>
                    [id, document.getElementById(id).value]));
            }

            function renderHistoryFilterPresets(selectedId = document.getElementById("history-filter-presets").value) {
                const select = document.getElementById("history-filter-presets");
                select.innerHTML = `<option value="">Selecionar filtro salvo</option>${historyFilterPresets
                    .map(preset => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</option>`)
                    .join("")}`;
                select.value = historyFilterPresets.some(preset => preset.id === selectedId) ? selectedId : "";
                document.getElementById("delete-history-filter").disabled = !select.value;
            }

            async function persistHistoryFilterPresets() {
                await database.settings.put({
                    key: STORAGE_HISTORY_FILTER_PRESETS,
                    value: historyFilterPresets
                });
                storageCache.set(STORAGE_HISTORY_FILTER_PRESETS, historyFilterPresets);
                renderHistoryFilterPresets();
            }

            function applyHistoryFilterPreset(preset) {
                if (!preset?.values || typeof preset.values !== "object") return;
                HISTORY_FILTER_FIELDS.forEach(id => {
                    const value = preset.values[id];
                    document.getElementById(id).value = typeof value === "string" ? value : "";
                });
                historyPage = 0;
                renderHistory();
            }

            function getCreditedMembers(service, record) {
                if (!service.queueTags.includes(QUEUE_TAGS.assistencia)) return [];
                const assistanceState = service.states?.assistencia;
                const receptionConfirmedAttendance = assistanceState?.finishedBy?.role === "reception"
                    && Boolean(assistanceState.finishedFollowupAt);
                const attendedByValue = receptionConfirmedAttendance
                    ? assistanceState.attendedBy || service.assignments?.assistencia
                    : service.assignments?.assistencia
                        || (isTechnicalUser(service.startedBy) ? service.startedBy : null);
                const attendedBy = isTechnicalUser(attendedByValue)
                    ? attendedByValue
                    : service.assignments?.assistencia;
                const credited = [
                    attendedBy,
                    ...(Array.isArray(service.collaborators)
                        ? service.collaborators.filter(isTechnicalUser)
                        : [])
                ]
                    .filter(member => member && typeof member.name === "string" && member.name);
                if (!credited.length && service.id.startsWith("legacy-")) {
                    return service.assignments?.assistencia?.name
                        ? [service.assignments.assistencia]
                        : [];
                }
                return credited.filter((member, index) =>
                    credited.findIndex(other => (other.id && member.id ? other.id === member.id : other.name === member.name)) === index);
            }

            function getServiceRows(record) {
                return getRecordServices(record).map(service => {
                    const hasTechnicalQueue = service.queueTags.includes(QUEUE_TAGS.assistencia);
                    const creditedMembers = getCreditedMembers(service, record);
                    const serviceMembers = hasTechnicalQueue && !creditedMembers.length
                        && service.assignments?.assistencia?.name
                        ? [service.assignments.assistencia]
                        : creditedMembers;
                    const uniqueMembers = serviceMembers.filter((member, index) =>
                        serviceMembers.findIndex(other => (other.id && member.id ? other.id === member.id : other.name === member.name)) === index);
                    return {
                        ...record,
                        encaminhamento: service.route,
                        assistente: uniqueMembers.map(member => member.name).join(", ")
                            || (hasTechnicalQueue ? record.assistente || "" : ""),
                        cadastradora: service.assignments?.cadastro?.name || record.cadastradora || "",
                        routeServiceId: service.id,
                        routeService: service,
                        serviceMembers: uniqueMembers
                    };
                });
            }

            function closeDeleteConfirmation(restoreFocus = true) {
                deleteConfirmOverlay.hidden = true;
                pendingDeleteRecordId = null;
                pendingDeleteServiceId = null;
                deleteConfirmTitle.textContent = "Excluir atendimento?";
                if (restoreFocus && deleteConfirmTrigger?.isConnected) deleteConfirmTrigger.focus();
                deleteConfirmTrigger = null;
            }

            function openDeleteConfirmation(record, trigger) {
                pendingDeleteRecordId = record.id;
                pendingDeleteServiceId = null;
                deleteConfirmTrigger = trigger;
                deleteConfirmTitle.textContent = "Excluir atendimento?";
                deleteConfirmMessage.textContent = `Tem certeza de que deseja excluir o atendimento de “${record.nome || "esta pessoa"}”?`;
                deleteConfirmOverlay.hidden = false;
                deleteConfirmCancel.focus();
            }

            function openDeleteServiceConfirmation(record, serviceId, trigger) {
                const service = getRecordServices(record).find(item => item.id === serviceId);
                if (!service) {
                    showToast("Não foi possível localizar esse encaminhamento.");
                    return;
                }
                pendingDeleteRecordId = record.id;
                pendingDeleteServiceId = serviceId;
                deleteConfirmTrigger = trigger;
                deleteConfirmTitle.textContent = "Excluir encaminhamento?";
                deleteConfirmMessage.textContent =
                    `Excluir somente “${displayRouteName(service.route)}” do atendimento de “${record.nome || "esta pessoa"}”? Os outros encaminhamentos serão mantidos.`;
                deleteConfirmOverlay.hidden = false;
                deleteConfirmCancel.focus();
            }

            async function deletePendingAppointment() {
                const recordId = pendingDeleteRecordId;
                const serviceId = pendingDeleteServiceId;
                const targetRecord = appointments.find(record => record.id === recordId);
                if (!targetRecord) {
                    closeDeleteConfirmation();
                    return;
                }
                if (serviceId) {
                    await deleteAppointmentService(targetRecord, serviceId);
                    return;
                }
                const recordIndex = appointments.findIndex(record => record.id === recordId);
                const remainingAppointments = appointments.filter(record => record.id !== recordId);
                if (!await saveStorage(STORAGE_RECORDS, remainingAppointments)) return;
                closeDeleteConfirmation(false);
                setHistoryUndoAction({ type: "delete", record: targetRecord, index: recordIndex });
                appointments = remainingAppointments;
                if (editingAppointmentId === recordId) resetFormState();
                renderAll();
            }

            async function deleteAppointmentService(record, serviceId) {
                const activeServices = getRecordServices(record);
                if (!activeServices.some(service => service.id === serviceId)) {
                    closeDeleteConfirmation();
                    showToast("Esse encaminhamento já foi removido.");
                    return;
                }
                const remainingServices = activeServices.filter(service => service.id !== serviceId);
                if (!remainingServices.length) {
                    closeDeleteConfirmation();
                    showToast("Para remover o último encaminhamento, exclua o atendimento completo.");
                    return;
                }
                const storedServices = Array.isArray(record.routeServices)
                    ? record.routeServices
                    : activeServices;
                const routeServices = storedServices.map(service => service.id === serviceId
                    ? { ...service, cancelled: true }
                    : service);
                const queueTags = [...new Set(remainingServices.flatMap(service => service.queueTags))];
                const otherTags = (Array.isArray(record.tags) ? record.tags : []).filter(tag =>
                    typeof tag === "string"
                    && ![...Object.values(QUEUE_TAGS), QUEUE_TAG_NONE]
                        .includes(tag.trim().toLocaleLowerCase("pt-BR")));
                const technicalService = remainingServices.find(service =>
                    service.queueTags.includes(QUEUE_TAGS.assistencia));
                const cadastroService = remainingServices.find(service =>
                    service.queueTags.includes(QUEUE_TAGS.cadastro));
                const updatedRecord = {
                    ...record,
                    routeServices,
                    encaminhamentos: remainingServices.map(service => service.route),
                    encaminhamento: remainingServices.map(service => service.route).join(", "),
                    assistente: technicalService?.assignments?.assistencia?.name
                        || (technicalService ? record.assistente || "" : ""),
                    cadastradora: cadastroService?.assignments?.cadastro?.name || "",
                    tags: [...otherTags, ...queueTags]
                };
                const updatedAppointments = appointments.map(item =>
                    item.id === record.id ? updatedRecord : item);
                if (!await saveStorage(STORAGE_RECORDS, updatedAppointments)) return;
                closeDeleteConfirmation(false);
                setHistoryUndoAction({ type: "edit", record });
                appointments = updatedAppointments;
                if (editingAppointmentId === record.id) populateFormWithRecord(updatedRecord);
                renderAll();
                showToast("Encaminhamento removido; os demais foram mantidos.");
            }

            function annotationCategoryLabel(category) {
                return category === "assistencia" ? "Anotações técnicas" : "Anotações cadastrais";
            }

            function annotationEntryMarkup(entry, category, record) {
                const author = entry.authorName || "Usuário";
                const authorRole = userRoleLabel(entry.authorRole);
                const attendedAt = entry.attendanceDate || record.createdAt;
                const editedBy = entry.updatedBy && entry.updatedBy !== entry.authorName
                    ? ` · Editada por ${entry.updatedBy}` : "";
                return `<div class="appointment-annotation-entry">
                    <p class="appointment-annotation-meta">${escapeHtml(author)} · ${escapeHtml(authorRole)} · Atendimento em ${escapeHtml(formatDateTime(attendedAt))}${escapeHtml(editedBy)}</p>
                    <textarea class="text-input" maxlength="6000" data-annotation-id="${escapeHtml(entry.id)}"
                        data-annotation-category="${category}" aria-label="${escapeHtml(annotationCategoryLabel(category))}">${escapeHtml(entry.text || "")}</textarea>
                </div>`;
            }

            function blankAnnotationEntryMarkup(category, record) {
                return `<div class="appointment-annotation-entry">
                    <p class="appointment-annotation-meta">Nova anotação · ${escapeHtml(activeUser?.name || "Usuário")} · Atendimento em ${escapeHtml(formatDateTime(record.createdAt))}</p>
                    <textarea class="text-input" maxlength="6000" data-annotation-new="true"
                        data-annotation-category="${category}" aria-label="Nova ${escapeHtml(annotationCategoryLabel(category))}"
                        placeholder="Escreva a anotação deste atendimento."></textarea>
                </div>`;
            }

            function appendBlankAnnotationEntry(category) {
                const container = appointmentAnnotationsCategories.querySelector(
                    `[data-annotation-list="${category}"]`
                );
                const record = appointments.find(item => item.id === appointmentAnnotationsRecordId);
                if (!container || !record) return;
                container.insertAdjacentHTML("beforeend", blankAnnotationEntryMarkup(category, record));
            }

            function openAppointmentAnnotations(record, trigger) {
                if (!canEditAppointmentAnnotations(record)) {
                    showToast("Seu perfil não pode editar as anotações deste atendimento.");
                    return;
                }
                appointmentAnnotationsRecordId = record.id;
                appointmentAnnotationsTrigger = trigger || null;
                appointmentAnnotationsTitle.textContent = "Anotações do atendimento";
                appointmentAnnotationsRecord.textContent =
                    `${record.nome || "Pessoa"} · ID da pessoa ${personIdForRecord(record)} · Atendimento em ${formatDateTime(record.createdAt)}`;
                appointmentAnnotationsCategories.innerHTML = getVisibleAnnotationCategories().map(category => {
                    const entries = getAnnotationEntries(record, category);
                    return `<section class="appointment-annotation-category" data-annotation-section="${category}">
                        <h3>${annotationCategoryLabel(category)}</h3>
                        <div data-annotation-list="${category}">
                            ${entries.map(entry => annotationEntryMarkup(entry, category, record)).join("")}
                            ${blankAnnotationEntryMarkup(category, record)}
                        </div>
                    </section>`;
                }).join("");
                appointmentAnnotationsStatus.textContent = "";
                appointmentAnnotationsSave.disabled = false;
                appointmentAnnotationsOverlay.hidden = false;
                appointmentAnnotationsCategories.querySelector("textarea")?.focus();
            }

            function closeAppointmentAnnotations(restoreFocus = true) {
                appointmentAnnotationsOverlay.hidden = true;
                appointmentAnnotationsRecordId = null;
                appointmentAnnotationsCategories.innerHTML = "";
                appointmentAnnotationsStatus.textContent = "";
                if (restoreFocus && appointmentAnnotationsTrigger?.isConnected) {
                    appointmentAnnotationsTrigger.focus();
                }
                appointmentAnnotationsTrigger = null;
            }

            async function saveAppointmentAnnotations() {
                const record = appointments.find(item => item.id === appointmentAnnotationsRecordId);
                if (!record || !canEditAppointmentAnnotations(record)) {
                    closeAppointmentAnnotations(false);
                    showToast("O atendimento não está mais disponível para anotação.");
                    return;
                }
                const categories = getVisibleAnnotationCategories();
                const nextAnnotations = { ...getAppointmentAnnotations(record) };
                const updatedAt = new Date().toISOString();
                let changed = false;
                for (const category of categories) {
                    const entries = getAnnotationEntries(record, category).map(entry => ({ ...entry }));
                    const entryMap = new Map(entries.map(entry => [entry.id, entry]));
                    const fields = appointmentAnnotationsCategories.querySelectorAll(
                        `[data-annotation-category="${category}"]`
                    );
                    for (const field of fields) {
                        const text = field.value.replace(/\r\n/g, "\n").trim();
                        const existing = field.dataset.annotationId
                            ? entryMap.get(field.dataset.annotationId) : null;
                        if (existing) {
                            if (!text) {
                                appointmentAnnotationsStatus.textContent =
                                    "Uma anotação existente não pode ficar vazia. Restaure o texto ou mantenha a anotação.";
                                field.focus();
                                return;
                            }
                            if (text !== existing.text) {
                                existing.text = text;
                                existing.updatedAt = updatedAt;
                                existing.updatedBy = activeUser.name;
                                changed = true;
                            }
                        } else if (text) {
                            const entry = {
                                id: createPersonKey(),
                                text,
                                authorName: activeUser.name,
                                authorRole: activeUser.role,
                                attendanceDate: record.createdAt,
                                createdAt: updatedAt,
                                updatedAt,
                                updatedBy: activeUser.name
                            };
                            entries.push(entry);
                            changed = true;
                        }
                    }
                    nextAnnotations[category] = entries;
                }
                if (!changed) {
                    closeAppointmentAnnotations();
                    return;
                }
                appointmentAnnotationsSave.disabled = true;
                const updatedRecord = { ...record, annotations: nextAnnotations };
                const updatedAppointments = appointments.map(item =>
                    item.id === record.id ? updatedRecord : item);
                try {
                    if (!await saveStorage(STORAGE_RECORDS, updatedAppointments)) return;
                    appointments = updatedAppointments;
                    closeAppointmentAnnotations(false);
                    renderAll();
                    showToast("Anotações salvas neste atendimento.");
                } finally {
                    appointmentAnnotationsSave.disabled = false;
                }
            }

            function renderHistory() {
                const records = getFilteredAppointments();
                const serviceCounts = new Map(appointments.map(record =>
                    [record.id, getRecordServices(record).length]));
                const pageCount = Math.max(1, Math.ceil(records.length / HISTORY_PAGE_SIZE));
                historyPage = Math.min(historyPage, pageCount - 1);
                const firstRecord = historyPage * HISTORY_PAGE_SIZE;
                const visibleRecords = records.slice(firstRecord, firstRecord + HISTORY_PAGE_SIZE);
                historyBody.innerHTML = visibleRecords.map(record => `<tr>
                    <td data-label="Data e hora">${escapeHtml(formatDateTime(record.createdAt))}</td>
                    <td data-label="Nome">${escapeHtml(record.nome)}<span class="person-id-label">ID da pessoa: ${escapeHtml(personIdForRecord(record))}</span></td>
                    <td data-label="Endereço">${escapeHtml(formattedAddress(record))}</td>
                    <td data-label="CPF">${escapeHtml(formatCpf(record.cpf))}</td>
                    <td data-label="Telefone">${escapeHtml(formatPhone(record.telefone))}</td>
                    <td data-label="Nacionalidade">${escapeHtml(record.nacionalidade ?? record.etnia ?? "")}</td>
                    <td data-label="Técnico(s)">${escapeHtml(record.assistente)}</td>
                    <td data-label="Encaminhamento">${escapeHtml(displayRouteName(record.encaminhamento))}</td>
                    <td data-label="Ações">
                        <div class="history-actions">
                            ${canEditAppointmentAnnotations(record)
                                ? `<button class="button-secondary" type="button" data-action="annotations" data-record-id="${escapeHtml(record.id)}">${annotationActionLabel(record)}</button>`
                                : ""}
                            <button class="button-secondary" type="button" data-action="edit" data-record-id="${escapeHtml(record.id)}">Editar</button>
                            ${serviceCounts.get(record.id) > 1
                                ? `<button class="button-delete" type="button" data-action="delete-service" data-record-id="${escapeHtml(record.id)}" data-service-id="${escapeHtml(record.routeServiceId)}">Excluir encaminhamento</button>`
                                : ""}
                            <button class="button-delete" type="button" data-action="delete" data-record-id="${escapeHtml(record.id)}">Excluir atendimento</button>
                        </div>
                    </td>
                </tr>`).join("");
                historyBody.querySelectorAll("button[data-action]").forEach(button => {
                    button.addEventListener("click", () => {
                        const { action, recordId } = button.dataset;
                        const targetRecord = appointments.find(record => record.id === recordId);
                        if (!targetRecord) return;
                        if (action === "edit") {
                            populateFormWithRecord(targetRecord);
                            return;
                        }
                        if (action === "annotations") {
                            openAppointmentAnnotations(targetRecord, button);
                            return;
                        }
                        if (action === "delete-service") {
                            openDeleteServiceConfirmation(targetRecord, button.dataset.serviceId, button);
                            return;
                        }
                        openDeleteConfirmation(targetRecord, button);
                    });
                });
                emptyState.hidden = records.length > 0;
                emptyState.innerHTML = records.length ? "" : `<strong>${appointments.length ? "Nenhum resultado encontrado" : "Nenhum atendimento registrado"}</strong>${appointments.length ? "Revise os filtros ou limpe a busca para ver os registros." : "Cadastre um atendimento para começar."}`;
                const pagination = document.getElementById("history-pagination");
                pagination.hidden = records.length <= HISTORY_PAGE_SIZE;
                document.getElementById("history-previous-page").disabled = historyPage === 0;
                document.getElementById("history-next-page").disabled = historyPage >= pageCount - 1;
                document.getElementById("history-page-status").textContent =
                    `Página ${historyPage + 1} de ${pageCount} · ${records.length} registros`;
                const totalServices = appointments.reduce((count, record) => count + getServiceRows(record).length, 0);
                document.getElementById("history-count").textContent =
                    `${records.length} ${records.length === 1 ? "atendimento" : "atendimentos"}${records.length !== totalServices ? ` de ${totalServices}` : ""}`;
            }

            function renderStaffHistory() {
                if (!["assistant", "caseworker"].includes(activeUser?.role)) {
                    staffHistoryList.innerHTML = "";
                    staffHistoryCount.textContent = "0 atendimentos";
                    staffHistoryEmpty.hidden = true;
                    staffHistoryPagination.hidden = true;
                    return;
                }
                const assignedRecords = appointments.filter(canEditAppointmentAnnotations)
                    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
                const query = staffHistorySearch.value.trim().toLocaleLowerCase("pt-BR");
                const matchingRecords = query
                    ? assignedRecords.filter(record => [
                        record.nome,
                        formatDateTime(record.createdAt),
                        personIdForRecord(record),
                        ...getRecordServices(record).map(service => displayRouteName(service.route))
                    ].some(value => String(value || "").toLocaleLowerCase("pt-BR").includes(query)))
                    : assignedRecords;
                const pageCount = Math.max(1, Math.ceil(matchingRecords.length / HISTORY_PAGE_SIZE));
                staffHistoryPage = Math.min(staffHistoryPage, pageCount - 1);
                const start = staffHistoryPage * HISTORY_PAGE_SIZE;
                const visibleRecords = matchingRecords.slice(start, start + HISTORY_PAGE_SIZE);
                staffHistoryList.innerHTML = visibleRecords.map(record => `<article class="staff-history-record">
                    <div>
                        <strong>${escapeHtml(record.nome || "Sem nome")}<span class="person-id-label">ID da pessoa: ${escapeHtml(personIdForRecord(record))}</span></strong>
                    </div>
                    <p>${escapeHtml(formatDateTime(record.createdAt))} · ${escapeHtml(getRecordServices(record).map(service => displayRouteName(service.route)).join(", ") || record.encaminhamento || "")}</p>
                    <button class="button-secondary" type="button" data-annotation-record="${escapeHtml(record.id)}">${annotationActionLabel(record)}</button>
                </article>`).join("");
                staffHistoryCount.textContent =
                    `${matchingRecords.length} ${matchingRecords.length === 1 ? "atendimento" : "atendimentos"}`;
                staffHistoryEmpty.hidden = matchingRecords.length > 0;
                staffHistoryEmpty.innerHTML = assignedRecords.length
                    ? "<strong>Nenhum atendimento encontrado</strong>Revise a pesquisa ou limpe o campo para ver os registros atribuídos a você."
                    : "<strong>Nenhum atendimento anterior atribuído</strong>Os atendimentos vinculados ao seu perfil aparecerão aqui.";
                staffHistoryPagination.hidden = matchingRecords.length <= HISTORY_PAGE_SIZE;
                document.getElementById("staff-history-previous-page").disabled = staffHistoryPage === 0;
                document.getElementById("staff-history-next-page").disabled = staffHistoryPage >= pageCount - 1;
                document.getElementById("staff-history-page-status").textContent =
                    `Página ${staffHistoryPage + 1} de ${pageCount}`;
            }

            async function loadMobileChatAttachment(image, message) {
                try {
                    const result = await syncChatRequest(mobileChatPeer(), {
                        operation: "attachment",
                        messageId: message.id,
                        recipientId: chatConversationRecipientId() || null
                    });
                    if (!result.attachment
                        || !CHAT_ATTACHMENT_TYPES.has(result.attachment.type)
                        || typeof result.attachment.data !== "string") {
                        throw new Error("O servidor retornou uma imagem inválida.");
                    }
                    if (image.isConnected) {
                        image.src = `data:${result.attachment.type};base64,${result.attachment.data}`;
                    }
                } catch (error) {
                    if (image.isConnected) {
                        image.alt = `Não foi possível carregar ${message.attachment.name || "a imagem"}: ${error.message}`;
                    }
                }
            }

            function renderChatMessages(scrollToBottom = false) {
                const container = chatMessagesElement;
                if (!chatMessages.length) {
                    container.innerHTML = "";
                    const empty = document.createElement("p");
                    empty.className = "hint";
                    empty.textContent = document.getElementById("chat-conversation-type").value === "direct"
                        ? chatConversationRecipientId()
                            ? "Ainda não há mensagens nesta conversa individual."
                            : "Escolha uma conversa na lista para começar."
                        : "Ainda não há avisos gerais.";
                    container.appendChild(empty);
                    return;
                }
                container.innerHTML = "";
                chatMessages.forEach(message => {
                    const article = document.createElement("article");
                    const ownMessage = message.authorId === activeUser?.id;
                    article.className = `chat-message${ownMessage ? " own" : ""}`;
                    const metadata = document.createElement("div");
                    metadata.className = "chat-message-meta";
                    const timestamp = new Intl.DateTimeFormat("pt-BR", {
                        timeStyle: "short"
                    }).format(new Date(message.createdAt));
                    metadata.textContent = ownMessage ? timestamp : `${message.authorName} · ${timestamp}`;
                    article.appendChild(metadata);

                    if (message.person) {
                        const person = document.createElement("p");
                        person.className = "chat-message-person";
                        person.textContent = `Pessoa da recomendação: ${message.person.name}${message.person.cpfMasked ? ` · CPF ${message.person.cpfMasked}` : ""}`;
                        article.appendChild(person);
                    }
                    if (message.text) {
                        const text = document.createElement("div");
                        text.className = "chat-message-text";
                        text.textContent = message.text;
                        article.appendChild(text);
                    }
                    if (message.attachment) {
                        const image = document.createElement("img");
                        image.className = "chat-message-image";
                        image.loading = "lazy";
                        image.alt = message.attachment.name || "Imagem anexada";
                        const query = new URLSearchParams({
                            id: message.id,
                            userId: activeUser?.id || ""
                        });
                        if (chatConversationRecipientId()) query.set("recipientId", chatConversationRecipientId());
                        if (mobileClient) {
                            void loadMobileChatAttachment(image, message);
                        } else {
                            image.src = `/api/chat/attachment?${query.toString()}`;
                        }
                        article.appendChild(image);
                    }
                    container.appendChild(article);
                });
                if (scrollToBottom) container.scrollTop = container.scrollHeight;
            }

            function chatConversationRecipientId() {
                return document.getElementById("chat-conversation-type").value === "direct"
                    ? chatRecipientId
                    : "";
            }

            function renderChatRecipients() {
                const selector = document.getElementById("chat-recipient-id");
                const previousValue = selector.value;
                const recipients = users
                    .filter(user => user.id !== activeUser?.id)
                    .sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));
                selector.innerHTML = '<option value="">Selecione um usuário</option>';
                recipients.forEach(user => {
                    const option = document.createElement("option");
                    option.value = user.id;
                    option.textContent = `${user.name} · ${userRoleLabel(user.role)}`;
                    selector.appendChild(option);
                });
                if (recipients.some(user => user.id === previousValue)) selector.value = previousValue;
                chatRecipientId = selector.value;
                selector.hidden = document.getElementById("chat-conversation-type").value !== "direct";
                selector.disabled = recipients.length === 0;
                const directConversation = document.getElementById("chat-conversation-type").value === "direct";
                const selectedRecipient = recipients.find(user => user.id === chatRecipientId);
                const title = directConversation
                    ? selectedRecipient?.name || "Selecione uma conversa"
                    : "Avisos gerais";
                document.getElementById("chat-title").textContent = title;
                document.getElementById("chat-active-avatar").textContent = directConversation && selectedRecipient
                    ? selectedRecipient.name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toLocaleUpperCase("pt-BR")
                    : "AG";
                renderChatConversationList(recipients);
            }

            function renderChatConversationList(recipients = users
                .filter(user => user.id !== activeUser?.id)
                .sort((left, right) => left.name.localeCompare(right.name, "pt-BR"))) {
                const list = document.getElementById("chat-conversation-list");
                const search = document.getElementById("chat-conversation-search").value
                    .trim().toLocaleLowerCase("pt-BR");
                list.innerHTML = "";
                const conversations = [
                    { kind: "general", id: "", name: "Avisos gerais", subtitle: "Toda a equipe", initials: "AG" },
                    ...recipients.map(user => ({
                        kind: "direct",
                        id: user.id,
                        name: user.name,
                        subtitle: userRoleLabel(user.role),
                        initials: user.name.trim().split(/\s+/).slice(0, 2)
                            .map(part => part[0]).join("").toLocaleUpperCase("pt-BR")
                    }))
                ];
                const selectedKind = document.getElementById("chat-conversation-type").value;
                conversations
                    .filter(conversation => !search
                        || conversation.name.toLocaleLowerCase("pt-BR").includes(search)
                        || conversation.subtitle.toLocaleLowerCase("pt-BR").includes(search))
                    .forEach(conversation => {
                        const button = document.createElement("button");
                        button.type = "button";
                        button.className = "chat-conversation-item";
                        button.setAttribute("aria-current", String(
                            selectedKind === conversation.kind
                            && (conversation.kind === "general" || conversation.id === chatRecipientId)
                        ));
                        button.dataset.chatKind = conversation.kind;
                        button.dataset.chatRecipient = conversation.id;
                        const avatar = document.createElement("span");
                        avatar.className = "chat-conversation-item-avatar";
                        avatar.setAttribute("aria-hidden", "true");
                        avatar.textContent = conversation.initials || "?";
                        const copy = document.createElement("span");
                        copy.className = "chat-conversation-item-copy";
                        const name = document.createElement("strong");
                        name.textContent = conversation.name;
                        const subtitle = document.createElement("small");
                        subtitle.textContent = conversation.subtitle;
                        copy.append(name, subtitle);
                        button.append(avatar, copy);
                        list.appendChild(button);
                    });
            }

            async function readPendingChatMessages() {
                const entry = await database.settings.get(STORAGE_PENDING_CHAT_MESSAGES);
                const messages = entry?.value || [];
                if (!Array.isArray(messages)) {
                    throw new Error("A fila local de mensagens do chat está inválida.");
                }
                return messages;
            }

            async function savePendingChatMessage(message) {
                const messages = await readPendingChatMessages();
                if (!messages.some(item => item.id === message.id)) messages.push(message);
                await database.settings.put({ key: STORAGE_PENDING_CHAT_MESSAGES, value: messages });
            }

            async function removePendingChatMessage(messageId) {
                const messages = await readPendingChatMessages();
                await database.settings.put({
                    key: STORAGE_PENDING_CHAT_MESSAGES,
                    value: messages.filter(message => message.id !== messageId)
                });
            }

            async function loadChatMessages(before = "", reset = false) {
                if (!window.CRASDesktop && !mobileClient) return;
                if (chatLoadInProgress) {
                    if (reset) chatReloadRequested = true;
                    return;
                }
                if (!activeUser) return;
                const recipientId = chatConversationRecipientId();
                const conversationType = document.getElementById("chat-conversation-type").value;
                const userId = activeUser.id;
                if (conversationType === "direct" && !recipientId) {
                    chatMessages = [];
                    renderChatMessages();
                    document.getElementById("chat-load-older").hidden = true;
                    document.getElementById("chat-connection-status").textContent =
                        "Escolha um usuário para abrir a conversa individual.";
                    return;
                }
                chatLoadInProgress = true;
                const wasNearBottom = chatMessagesElement.scrollHeight
                    - chatMessagesElement.scrollTop - chatMessagesElement.clientHeight < 60;
                try {
                    let result;
                    if (mobileClient) {
                        result = await syncChatRequest(mobileChatPeer(), {
                            operation: "list",
                            limit: CHAT_PAGE_SIZE,
                            before,
                            recipientId: recipientId || null
                        });
                    } else {
                        const query = new URLSearchParams({
                            limit: String(CHAT_PAGE_SIZE),
                            userId
                        });
                        if (recipientId) query.set("recipientId", recipientId);
                        if (before) query.set("before", before);
                        const response = await fetchPeer(
                            `/api/chat/messages?${query.toString()}`,
                            { cache: "no-store" },
                            5000
                        );
                        result = await response.json();
                        if (!response.ok) {
                            throw new Error(result.error || "Não foi possível carregar as mensagens.");
                        }
                    }
                    if (!Array.isArray(result.messages)) {
                        throw new Error("O servidor retornou mensagens inválidas.");
                    }
                    const byId = new Map((reset ? [] : chatMessages).map(message => [message.id, message]));
                    result.messages.forEach(message => byId.set(message.id, message));
                    let server = null;
                    let serverStatus = mobileClient || desktopNodeInfo?.centralServer
                        ? "Chat conectado ao servidor central."
                        : "Mensagens locais; procurando o servidor central automaticamente.";
                    if (window.CRASDesktop && !desktopNodeInfo?.centralServer) {
                        try {
                            server = (await discoverCentralServer())[0] || null;
                        } catch (error) {
                            serverStatus = `Chat local; descoberta indisponível: ${error.message}`;
                        }
                    }
                    if (window.CRASDesktop && server) {
                        try {
                            const pendingMessages = await readPendingChatMessages();
                            for (const message of pendingMessages.filter(item => item.authorId === activeUser.id)) {
                                await syncChatMessageWithServer(server, message);
                                await removePendingChatMessage(message.id);
                            }
                            const remote = await syncChatRequest(server, {
                                operation: "list",
                                limit: CHAT_PAGE_SIZE,
                                before,
                                recipientId: recipientId || null
                            });
                            if (!Array.isArray(remote.messages)) {
                                throw new Error("O servidor central retornou uma lista de mensagens inválida.");
                            }
                            for (const remoteMessage of remote.messages) {
                                if (byId.has(remoteMessage.id)) continue;
                                const message = { ...remoteMessage };
                                if (message.attachment) {
                                    const attachment = await syncChatRequest(server, {
                                        operation: "attachment",
                                        messageId: message.id,
                                        recipientId: recipientId || null
                                    });
                                    if (!attachment.attachment
                                        || !CHAT_ATTACHMENT_TYPES.has(attachment.attachment.type)
                                        || typeof attachment.attachment.data !== "string") {
                                        throw new Error("O servidor central retornou uma imagem inválida.");
                                    }
                                    message.attachment = {
                                        ...message.attachment,
                                        type: attachment.attachment.type,
                                        data: attachment.attachment.data
                                    };
                                }
                                const storeResponse = await fetchPeer("/api/chat/messages", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify(message)
                                });
                                const stored = await storeResponse.json();
                                if (!storeResponse.ok || !stored.message) {
                                    throw new Error(stored.error || "Não foi possível guardar a mensagem sincronizada neste computador.");
                                }
                                byId.set(stored.message.id, stored.message);
                            }
                            serverStatus = "Chat sincronizado com o servidor central.";
                        } catch (error) {
                            serverStatus = `Chat local; servidor central indisponível: ${error.message}`;
                            if (!chatLoadErrorShown) {
                                console.error("Não foi possível sincronizar o chat com o servidor central.", error);
                                chatLoadErrorShown = true;
                            }
                        }
                    }
                    if (activeUser?.id !== userId
                        || document.getElementById("chat-conversation-type").value !== conversationType
                        || chatConversationRecipientId() !== recipientId) {
                        chatReloadRequested = true;
                        return;
                    }
                    chatMessages = Array.from(byId.values())
                        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
                        .slice(-300);
                    document.getElementById("chat-load-older").hidden = result.messages.length < CHAT_PAGE_SIZE;
                    renderChatMessages(!before && wasNearBottom);
                    document.getElementById("chat-connection-status").textContent = serverStatus;
                    if (server) chatLoadErrorShown = serverStatus.startsWith("Chat local;");
                } catch (error) {
                    if (activeUser?.id !== userId
                        || document.getElementById("chat-conversation-type").value !== conversationType
                        || chatConversationRecipientId() !== recipientId) {
                        chatReloadRequested = true;
                        return;
                    }
                    document.getElementById("chat-connection-status").textContent =
                        `Não foi possível atualizar o chat: ${error.message}`;
                    if (!chatLoadErrorShown) {
                        console.error("Não foi possível atualizar as mensagens do chat.", error);
                        chatLoadErrorShown = true;
                    }
                } finally {
                    chatLoadInProgress = false;
                    if (chatReloadRequested) {
                        chatReloadRequested = false;
                        void loadChatMessages("", true);
                    }
                }
            }

            function renderChatPersonSuggestions() {
                const input = document.getElementById("chat-person-search");
                const suggestions = document.getElementById("chat-person-suggestions");
                const query = input.value.trim().toLocaleLowerCase("pt-BR");
                const digits = query.replace(/\D/g, "");
                suggestions.innerHTML = "";
                if (!query) {
                    suggestions.hidden = true;
                    return;
                }
                const matches = [...appointments]
                    .filter(record => (record.nome || "").toLocaleLowerCase("pt-BR").includes(query)
                        || digits && (record.cpf || "").replace(/\D/g, "").includes(digits))
                    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
                    .slice(0, 8);
                matches.forEach(record => {
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className = "chat-person-suggestion";
                    button.setAttribute("role", "option");
                    button.dataset.personId = record.id;
                    const cpfDigits = (record.cpf || "").replace(/\D/g, "");
                    button.textContent = `${record.nome || "Pessoa sem nome"}${cpfDigits ? ` · CPF final ${cpfDigits.slice(-2)}` : ""}`;
                    suggestions.appendChild(button);
                });
                suggestions.hidden = matches.length === 0;
            }

            function clearChatPerson() {
                chatPerson = null;
                document.getElementById("chat-selected-person").hidden = true;
                document.getElementById("chat-person-search").value = "";
                document.getElementById("chat-person-suggestions").hidden = true;
            }

            function clearChatAttachment() {
                chatAttachment = null;
                document.getElementById("chat-attachment-input").value = "";
                document.getElementById("chat-attachment-name").textContent = "";
                document.getElementById("chat-clear-attachment").hidden = true;
            }

            async function readChatAttachment(file) {
                if (!CHAT_ATTACHMENT_TYPES.has(file.type)) {
                    throw new Error("Escolha uma imagem PNG, JPG, GIF ou WebP.");
                }
                if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
                    throw new Error("A imagem ou GIF deve ter no máximo 2 MB.");
                }
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onerror = () => reject(new Error("Não foi possível ler o arquivo de imagem."));
                    reader.onload = () => resolve(reader.result);
                    reader.readAsDataURL(file);
                });
                const data = String(dataUrl).split(",", 2)[1];
                if (!data) throw new Error("O arquivo de imagem está vazio ou inválido.");
                return { name: file.name.slice(0, 120), type: file.type, data };
            }

            async function syncChatRequest(peer, payload) {
                const endpoint = mobileClient
                    ? location.origin
                    : getSyncBridgeUrl(peer.endpoint);
                if (!endpoint || !peer.userId || !peer.credential?.hash) {
                    throw new Error("A conversa não possui uma credencial individual válida.");
                }
                await registerUserWithServer(peer);
                const salt = crypto.getRandomValues(new Uint8Array(16));
                const nonce = crypto.getRandomValues(new Uint8Array(12));
                const key = await derivePeerKey(peer.credential.hash, salt);
                const authenticatedPayload = { ...payload, userId: peer.userId };
                const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
                    { name: "AES-GCM", iv: nonce },
                    key,
                    new TextEncoder().encode(JSON.stringify(authenticatedPayload))
                ));
                const response = await fetchPeer(`${endpoint}/api/chat/sync`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        userId: peer.userId,
                        salt: bytesToBase64(salt),
                        nonce: bytesToBase64(nonce),
                        ciphertext: bytesToBase64(ciphertext)
                    })
                }, 5000);
                const resultEnvelope = await response.json();
                if (!response.ok) {
                    throw new Error(resultEnvelope.error || "O servidor central recusou a operação de chat.");
                }
                const result = await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: base64ToBytes(resultEnvelope.nonce) },
                    key,
                    base64ToBytes(resultEnvelope.ciphertext)
                );
                return JSON.parse(new TextDecoder().decode(result));
            }

            function mobileChatPeer() {
                const user = users.find(item => item.id === activeUser?.id);
                if (!user?.passwordCredential?.salt || !user.passwordCredential.hash) {
                    throw new Error("Entre com sua senha individual para acessar o chat.");
                }
                return {
                    endpoint: location.origin,
                    userId: user.id,
                    name: user.name,
                    role: user.role,
                    credential: user.passwordCredential
                };
            }

            async function syncChatMessageWithServer(server, message) {
                if (message.authorId !== server.userId) {
                    throw new Error("A mensagem pendente pertence a outro usuário.");
                }
                const result = await syncChatRequest(server, { operation: "send", message });
                if (result.messageId !== message.id) {
                    throw new Error("O servidor central confirmou uma mensagem diferente.");
                }
            }

            async function submitChatMessage(event) {
                event.preventDefault();
                if (!activeUser) {
                    document.getElementById("chat-connection-status").textContent =
                        "Selecione um usuário antes de enviar mensagens.";
                    return;
                }
                const recipientId = chatConversationRecipientId();
                if (document.getElementById("chat-conversation-type").value === "direct" && !recipientId) {
                    document.getElementById("chat-connection-status").textContent =
                        "Selecione um usuário para a mensagem individual.";
                    document.getElementById("chat-recipient-id").focus();
                    return;
                }
                const textInput = document.getElementById("chat-message-input");
                const text = textInput.value.trim();
                if (!text && !chatPerson && !chatAttachment) {
                    document.getElementById("chat-connection-status").textContent =
                        "Escreva uma mensagem, vincule uma pessoa ou selecione uma imagem.";
                    textInput.focus();
                    return;
                }
                const sendButton = document.getElementById("chat-send");
                sendButton.disabled = true;
                const message = {
                    id: crypto.randomUUID(),
                    createdAt: new Date().toISOString(),
                    authorId: activeUser.id,
                    authorName: activeUser.name,
                    authorRole: activeUser.role,
                    ...(recipientId ? { recipientId } : {}),
                    text,
                    ...(chatPerson ? { person: chatPerson } : {}),
                    ...(chatAttachment ? { attachment: chatAttachment } : {})
                };
                try {
                    let storedMessage;
                    if (mobileClient) {
                        const result = await syncChatRequest(mobileChatPeer(), {
                            operation: "send",
                            message
                        });
                        if (result.messageId !== message.id) {
                            throw new Error("O servidor central não confirmou esta mensagem.");
                        }
                        storedMessage = { ...message };
                        if (storedMessage.attachment) {
                            storedMessage.attachment = {
                                name: storedMessage.attachment.name,
                                type: storedMessage.attachment.type
                            };
                        }
                    } else {
                        const response = await fetchPeer("/api/chat/messages", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(message)
                        });
                        const result = await response.json();
                        if (!response.ok) {
                            throw new Error(result.error || "Não foi possível salvar a mensagem neste computador.");
                        }
                        storedMessage = result.message;
                    }
                    if (!storedMessage) {
                        throw new Error("O servidor não confirmou o envio da mensagem.");
                    }
                    chatMessages.push(storedMessage);
                    chatMessages = chatMessages.slice(-300);
                    renderChatMessages(true);
                    textInput.value = "";
                    clearChatPerson();
                    clearChatAttachment();

                    if (mobileClient) {
                        document.getElementById("chat-connection-status").textContent =
                            "Mensagem enviada ao servidor central.";
                    } else {
                        let server = null;
                        if (!desktopNodeInfo?.centralServer) {
                            try {
                                server = (await discoverCentralServer())[0] || null;
                            } catch (error) {
                                console.warn("Não foi possível localizar o servidor central para o chat.", error);
                            }
                        }
                        const results = await Promise.allSettled(
                            server ? [syncChatMessageWithServer(server, storedMessage)] : []
                        );
                        const failures = results.filter(item => item.status === "rejected");
                        if (desktopNodeInfo?.centralServer) {
                            document.getElementById("chat-connection-status").textContent =
                                "Mensagem salva no servidor central.";
                        } else if (failures.length || !server) {
                            try {
                                await savePendingChatMessage(storedMessage);
                                document.getElementById("chat-connection-status").textContent = server
                                    ? "Mensagem salva neste PC; envio ao servidor central pendente."
                                    : "Mensagem salva neste PC; será enviada quando o servidor central for encontrado.";
                            } catch (error) {
                                console.error("Não foi possível registrar a mensagem na fila de reenvio.", error);
                                document.getElementById("chat-connection-status").textContent =
                                    `Mensagem salva neste PC, mas não foi possível preparar o reenvio: ${error.message}`;
                            }
                        } else {
                            document.getElementById("chat-connection-status").textContent =
                                "Mensagem enviada ao servidor central.";
                        }
                        failures.forEach(failure =>
                            console.error("Falha ao enviar mensagem ao servidor central.", failure.reason));
                    }
                } catch (error) {
                    console.error("Falha ao salvar a mensagem do chat.", error);
                    document.getElementById("chat-connection-status").textContent =
                        `Não foi possível enviar a mensagem: ${error.message}`;
                } finally {
                    sendButton.disabled = false;
                    textInput.focus();
                }
            }

            function startChatServices() {
                renderChatRecipients();
                if (!window.CRASDesktop && !mobileClient) return;
                void loadChatMessages("", true);
                if (chatPollTimer !== null) window.clearInterval(chatPollTimer);
                chatPollTimer = window.setInterval(() => {
                    if (document.visibilityState === "visible") void loadChatMessages();
                }, 4000);
            }

            function setChatPopupOpen(isOpen) {
                const open = Boolean(isOpen) && !chatToggle.hidden;
                chatPanel.hidden = !open;
                document.body.classList.toggle("mobile-chat-open", open && mobileClient);
                chatToggle.setAttribute("aria-expanded", String(open));
                chatToggle.setAttribute("aria-label", open ? "Fechar chat" : "Abrir chat");
                if (open) {
                    renderChatRecipients();
                    void loadChatMessages("", true);
                    window.requestAnimationFrame(() => document.getElementById("chat-message-input").focus());
                } else if (!chatToggle.hidden) {
                    chatToggle.focus();
                }
            }

            let customReportExport = null;

            function generateCustomReport() {
                const dateFrom = document.getElementById("report-date-from");
                const dateTo = document.getElementById("report-date-to");
                const assistant = document.getElementById("report-assistant").value;
                const status = document.getElementById("report-status");
                const reportResults = document.getElementById("report-results");
                customReportExport = null;
                reportResults.hidden = true;
                status.textContent = "";
                const selectedColumns = Array.from(document.querySelectorAll("input[name='report-column']:checked"))
                    .map(input => REPORT_COLUMNS.find(column => column.key === input.value))
                    .filter(Boolean);

                if (!dateFrom.reportValidity()) return;
                if (!dateTo.reportValidity()) return;
                if (dateFrom.value > dateTo.value) {
                    status.textContent = "A data inicial deve ser anterior ou igual à data final.";
                    dateFrom.focus();
                    return;
                }
                if (!selectedColumns.length) {
                    status.textContent = "Selecione ao menos uma coluna para montar a tabela.";
                    document.querySelector("input[name='report-column']").focus();
                    return;
                }

                const records = appointments.flatMap(getServiceRows)
                    .filter(record => {
                        const date = dateKey(record.createdAt);
                        return date >= dateFrom.value && date <= dateTo.value
                            && (!assistant || record.serviceMembers.some(member => member.name === assistant));
                    })
                    .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
                const reportHead = document.getElementById("report-head");
                const reportBody = document.getElementById("report-body");
                const reportEmpty = document.getElementById("report-empty");
                const dateFormatter = new Intl.DateTimeFormat("pt-BR");
                const fromLabel = dateFormatter.format(new Date(`${dateFrom.value}T12:00:00`));
                const toLabel = dateFormatter.format(new Date(`${dateTo.value}T12:00:00`));

                reportHead.innerHTML = `<tr>${selectedColumns.map(column => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr>`;
                reportBody.innerHTML = records.map(record => `<tr>${selectedColumns.map(column =>
                    `<td>${escapeHtml(column.value(record))}</td>`).join("")}</tr>`).join("");
                document.getElementById("report-results-count").textContent =
                    `${records.length} ${records.length === 1 ? "atendimento" : "atendimentos"} · ${fromLabel} a ${toLabel}${assistant ? ` · ${assistant}` : ""}`;
                reportEmpty.hidden = records.length > 0;
                reportResults.hidden = false;
                customReportExport = {
                    records,
                    columns: selectedColumns,
                    dateFrom: dateFrom.value,
                    dateTo: dateTo.value
                };
                status.textContent = "Tabela atualizada.";
                reportResults.scrollIntoView({ behavior: "smooth", block: "start" });
            }

            function crc32(bytes) {
                const table = new Uint32Array(256);
                for (let index = 0; index < table.length; index += 1) {
                    let value = index;
                    for (let bit = 0; bit < 8; bit += 1) {
                        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
                    }
                    table[index] = value >>> 0;
                }
                let crc = 0xffffffff;
                for (const byte of bytes) {
                    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
                }
                return (crc ^ 0xffffffff) >>> 0;
            }

            function zipStoredFiles(files) {
                const encoder = new TextEncoder();
                const localParts = [];
                const centralParts = [];
                let localOffset = 0;
                let centralSize = 0;

                files.forEach(({ name, content }) => {
                    const nameBytes = encoder.encode(name);
                    const contentBytes = encoder.encode(content);
                    const checksum = crc32(contentBytes);
                    const localHeader = new Uint8Array(30 + nameBytes.length);
                    const localView = new DataView(localHeader.buffer);
                    localView.setUint32(0, 0x04034b50, true);
                    localView.setUint16(4, 20, true);
                    localView.setUint16(6, 0x0800, true);
                    localView.setUint16(12, 0x0021, true);
                    localView.setUint32(14, checksum, true);
                    localView.setUint32(18, contentBytes.length, true);
                    localView.setUint32(22, contentBytes.length, true);
                    localView.setUint16(26, nameBytes.length, true);
                    localHeader.set(nameBytes, 30);
                    localParts.push(localHeader, contentBytes);

                    const centralHeader = new Uint8Array(46 + nameBytes.length);
                    const centralView = new DataView(centralHeader.buffer);
                    centralView.setUint32(0, 0x02014b50, true);
                    centralView.setUint16(4, 20, true);
                    centralView.setUint16(6, 20, true);
                    centralView.setUint16(8, 0x0800, true);
                    centralView.setUint16(14, 0x0021, true);
                    centralView.setUint32(16, checksum, true);
                    centralView.setUint32(20, contentBytes.length, true);
                    centralView.setUint32(24, contentBytes.length, true);
                    centralView.setUint16(28, nameBytes.length, true);
                    centralView.setUint32(42, localOffset, true);
                    centralHeader.set(nameBytes, 46);
                    centralParts.push(centralHeader);
                    localOffset += localHeader.length + contentBytes.length;
                    centralSize += centralHeader.length;
                });

                const entryCount = files.length;
                const endRecord = new Uint8Array(22);
                const endView = new DataView(endRecord.buffer);
                endView.setUint32(0, 0x06054b50, true);
                endView.setUint16(8, entryCount, true);
                endView.setUint16(10, entryCount, true);
                endView.setUint32(12, centralSize, true);
                endView.setUint32(16, localOffset, true);
                const archive = new Uint8Array(localOffset + centralSize + endRecord.length);
                let offset = 0;
                [...localParts, ...centralParts, endRecord].forEach(part => {
                    archive.set(part, offset);
                    offset += part.length;
                });
                return new Blob([archive], { type: "application/vnd.oasis.opendocument.spreadsheet" });
            }

            function exportCustomReportToOds() {
                if (!customReportExport) return;
                const xmlEscape = value => String(value ?? "")
                    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
                    .replace(/[&<>"']/g, character => ({
                        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
                    })[character]);
                const tableRows = [
                    customReportExport.columns.map(column => column.label),
                    ...customReportExport.records.map(record =>
                        customReportExport.columns.map(column => column.value(record)))
                ];
                const rowsXml = tableRows.map(row => `<table:table-row>${row.map(value =>
                    `<table:table-cell office:value-type="string"><text:p>${xmlEscape(value)}</text:p></table:table-cell>`
                ).join("")}</table:table-row>`).join("");
                const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2"><office:automatic-styles/><office:body><office:spreadsheet><table:table table:name="Atendimentos">${rowsXml}</table:table></office:spreadsheet></office:body></office:document-content>`;
                const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" office:version="1.2"><office:styles/><office:automatic-styles/><office:master-styles/></office:document-styles>`;
                const metaXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2"><office:meta><dc:title>Atendimentos CRAS Ouro Preto</dc:title><meta:generator>CRAS Desktop</meta:generator></office:meta></office:document-meta>`;
                const settingsXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" office:version="1.2"><office:settings/></office:document-settings>`;
                const manifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="settings.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
                try {
                    const blob = zipStoredFiles([
                        { name: "mimetype", content: "application/vnd.oasis.opendocument.spreadsheet" },
                        { name: "content.xml", content: contentXml },
                        { name: "styles.xml", content: stylesXml },
                        { name: "meta.xml", content: metaXml },
                        { name: "settings.xml", content: settingsXml },
                        { name: "META-INF/manifest.xml", content: manifestXml }
                    ]);
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = `atendimentos-${customReportExport.dateFrom}-a-${customReportExport.dateTo}.ods`;
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                    showToast(`${customReportExport.records.length} ${customReportExport.records.length === 1
                        ? "atendimento exportado" : "atendimentos exportados"} para .ods.`);
                } catch (error) {
                    console.error("Falha ao exportar a tabela personalizada para ODS.", error);
                    showToast("Não foi possível gerar o arquivo .ods. Tente novamente.");
                }
            }

            deleteConfirmCancel.addEventListener("click", () => closeDeleteConfirmation());
            deleteConfirmSubmit.addEventListener("click", async event => {
                if (event.detail === 0) return;
                await deletePendingAppointment();
            });
            deleteConfirmOverlay.addEventListener("click", event => {
                if (event.target === deleteConfirmOverlay) closeDeleteConfirmation();
            });
            document.addEventListener("keydown", event => {
                if (deleteConfirmOverlay.hidden) return;
                if (event.key === "Escape") {
                    closeDeleteConfirmation();
                    return;
                }
                if (event.key === "Tab") {
                    event.preventDefault();
                    const nextFocus = document.activeElement === deleteConfirmCancel ? deleteConfirmSubmit : deleteConfirmCancel;
                    nextFocus.focus();
                }
            });

            function setHistoryUndoAction(action) {
                historyUndoAction = action;
                const button = document.getElementById("history-undo");
                button.disabled = !action;
                button.textContent = action?.type === "delete" ? "Desfazer exclusão" : action ? "Desfazer alteração" : "Desfazer";
            }

            async function undoHistoryAction() {
                if (!historyUndoAction) return;
                const action = historyUndoAction;
                const restoredAppointments = [...appointments];
                if (action.type === "delete") {
                    if (restoredAppointments.some(record => record.id === action.record.id)) {
                        showToast("Não foi possível desfazer: já existe um atendimento com este identificador.");
                        return;
                    }
                    restoredAppointments.splice(Math.min(action.index, restoredAppointments.length), 0, action.record);
                } else {
                    const recordIndex = restoredAppointments.findIndex(record => record.id === action.record.id);
                    if (recordIndex === -1) {
                        showToast("Não foi possível desfazer: o atendimento alterado não está mais no histórico.");
                        return;
                    }
                    restoredAppointments[recordIndex] = action.record;
                }
                if (!await saveStorage(STORAGE_RECORDS, restoredAppointments)) return;
                appointments = restoredAppointments;
                setHistoryUndoAction(null);
                if (action.type === "edit" && editingAppointmentId === action.record.id) populateFormWithRecord(action.record);
                renderAll();
                showToast(action.type === "delete" ? "Exclusão desfeita." : "Alteração desfeita.");
            }

            function updateExportDates() {
                const select = document.getElementById("export-date");
                const dates = [...new Set(appointments.map(record => dateKey(record.createdAt)).filter(Boolean))].sort().reverse();
                const previous = select.value;
                select.innerHTML = dates.length ? dates.map(date => `<option value="${date}">${new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date(`${date}T12:00:00`))}</option>`).join("") : `<option value="">Nenhum dia disponível</option>`;
                if (dates.includes(previous)) select.value = previous;
                const monthSelect = document.getElementById("export-month");
                const months = [...new Set(dates.map(date => date.slice(0, 7)))].sort().reverse();
                const previousMonth = monthSelect.value;
                monthSelect.innerHTML = months.length
                    ? months.map(month => `<option value="${month}">${new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(new Date(`${month}-01T12:00:00`))}</option>`).join("")
                    : `<option value="">Nenhum mês disponível</option>`;
                if (months.includes(previousMonth)) monthSelect.value = previousMonth;
                document.getElementById("export-latest").textContent = dates.length ? `Exportar último dia · ${new Intl.DateTimeFormat("pt-BR").format(new Date(`${dates[0]}T12:00:00`))}` : "Exportar último dia (sem registros)";
                document.getElementById("export-latest").disabled = !dates.length;
                document.getElementById("export-selected").disabled = !dates.length;
                document.getElementById("export-month-selected").disabled = !months.length;
                document.getElementById("export-all").disabled = !dates.length;
            }

            function renderAll() {
                renderDashboard();
                renderQueues();
                renderHistory();
                renderStaffHistory();
                updateExportDates();
                renderPaaHistory();
                updateAdminOperationsStatus();
            }

            function selectMainTab(tab) {
                const isStaff = activeUser?.role === "assistant" || activeUser?.role === "caseworker";
                const mobileIntern = mobileClient && activeUser?.role === "intern";
                const canShowQueues = hostedAppsScript || isStaff || mobileIntern;
                let selectedTab = tab;
                if (selectedTab === "paa" && (isStaff || !preferences.paaEnabled)) {
                    selectedTab = canShowQueues ? "queues" : "attendance";
                } else if (selectedTab === "queues" && !canShowQueues) {
                    selectedTab = "attendance";
                }
                const showPaa = !isStaff && selectedTab === "paa" && Boolean(preferences.paaEnabled);
                const showQueues = selectedTab === "queues" && canShowQueues;
                currentMainTab = showQueues ? "queues" : showPaa ? "paa" : "attendance";
                queuesTab.setAttribute("aria-selected", String(showQueues));
                attendanceTab.setAttribute("aria-selected", String(!showPaa && !showQueues));
                paaTab.setAttribute("aria-selected", String(showPaa));
                queuesPanel.hidden = !showQueues;
                attendancePanel.hidden = isStaff || showPaa || mobileIntern && showQueues;
                paaPanel.hidden = !showPaa;
            }

            function setupModuleTabs() {
                if (!hostedAppsScript) return;
                queuesTab.hidden = false;
                const queueDashboards = document.querySelector(".queue-dashboards");
                if (!queueDashboards) {
                    throw new Error("Não foi possível localizar os painéis de fila para abrir a aba dedicada.");
                }
                document.getElementById("queue-panel-content").appendChild(queueDashboards);
                selectMainTab("queues");
            }

            function paaMonthLabel(monthKey) {
                const [year, month] = monthKey.split("-").map(Number);
                const label = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" })
                    .format(new Date(year, month - 1, 15));
                return label.charAt(0).toLocaleUpperCase("pt-BR") + label.slice(1);
            }

            function previousMonthKey(monthKey) {
                const [year, month] = monthKey.split("-").map(Number);
                const previousMonth = new Date(year, month - 2, 1);
                return `${previousMonth.getFullYear()}-${String(previousMonth.getMonth() + 1).padStart(2, "0")}`;
            }

            function nextMonthKey(monthKey) {
                const [year, month] = monthKey.split("-").map(Number);
                const nextMonth = new Date(year, month, 1);
                return `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}`;
            }

            function renderPaaHistory() {
                const monthKeys = [...new Set(paaRecords.map(record => record.month))].sort((a, b) => b.localeCompare(a));
                const pendingSyncCount = paaRecords.filter(record => !record.googleSyncedAt
                    && !record.googleSheetUnlinked).length;
                const syncPendingButton = document.getElementById("paa-sync-pending");
                syncPendingButton.disabled = pendingSyncCount === 0;
                syncPendingButton.textContent = pendingSyncCount
                    ? `Enviar ${pendingSyncCount} ${pendingSyncCount === 1 ? "pendente" : "pendentes"} ao Google`
                    : "Enviar pendentes ao Google";
                if (pendingSyncCount && !hasGoogleAppsScriptBridge()) {
                    paaSyncStatus.textContent = window.CRASDesktop
                        ? getGoogleAppsScriptBridgeUrl()
                            ? "Registros salvos neste computador. Conecte ao Google Sheets nas Configurações para enviá-los."
                            : "Registros salvos neste computador. Configure o URL do Apps Script em Configurações para enviá-los."
                        : "Os registros estão salvos neste dispositivo. Para enviar ao Google, abra o sistema pelo link publicado no Apps Script.";
                } else if (!pendingSyncCount && paaSyncStatus.textContent.startsWith("Os registros estão salvos neste dispositivo.")) {
                    paaSyncStatus.textContent = "";
                }
                document.getElementById("paa-history-count").textContent =
                    `${paaRecords.length} ${paaRecords.length === 1 ? "participante" : "participantes"}`;
                paaEmptyState.hidden = paaRecords.length > 0;

                const recordsByMonth = new Map();
                paaRecords.forEach(record => {
                    if (!recordsByMonth.has(record.month)) recordsByMonth.set(record.month, []);
                    recordsByMonth.get(record.month).push(record);
                });
                paaHistoryGroups.innerHTML = monthKeys.map((month, index) => {
                    const records = recordsByMonth.get(month).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
                    return `<details class="panel paa-month-group"${index === 0 ? " open" : ""}>
                        <summary>${escapeHtml(paaMonthLabel(month))}<span>${records.length} ${records.length === 1 ? "registro" : "registros"}</span></summary>
                        <div class="table-wrap">
                            <table class="history-table">
                                <thead><tr><th>Nome</th><th>CPF</th><th>Telefone</th><th>Nacionalidade</th><th>Ações</th></tr></thead>
                                <tbody>${records.map(record => `<tr>
                                    <td>${escapeHtml(record.nome)}</td>
                                    <td>${escapeHtml(formatCpf(record.cpf))}</td>
                                    <td>${escapeHtml(formatPhone(record.telefone))}</td>
                                    <td>${escapeHtml(record.nacionalidade)}</td>
                                    <td><div class="paa-row-actions">
                                        <button class="button-secondary" type="button" data-paa-action="edit" data-record-id="${escapeHtml(record.id)}">Editar</button>
                                        <button class="button-delete" type="button" data-paa-action="delete" data-record-id="${escapeHtml(record.id)}">Excluir</button>
                                    </div></td>
                                </tr>`).join("")}</tbody>
                            </table>
                        </div>
                    </details>`;
                }).join("");
                paaHistoryGroups.querySelectorAll("button[data-paa-action]").forEach(button => {
                    button.addEventListener("click", async () => {
                        const record = paaRecords.find(item => item.id === button.dataset.recordId);
                        if (!record) return;
                        if (button.dataset.paaAction === "edit") {
                            editPaaRecord(record);
                            return;
                        }
                        await deletePaaRecord(record);
                    });
                });
            }

            function editPaaRecord(record) {
                editingPaaRecordId = record.id;
                paaNameInput.value = record.nome;
                paaCpfInput.value = formatCpf(record.cpf);
                paaPhoneInput.value = formatPhone(record.telefone);
                document.getElementById("paa-nationality").value = record.nacionalidade || "";
                paaMonthInput.value = record.month;
                paaForm.querySelector('button[type="submit"]').textContent = "Salvar alterações";
                document.getElementById("paa-cancel-edit").hidden = false;
                paaFormStatus.textContent = `Editando o registro de ${record.nome}.`;
                paaForm.scrollIntoView({ behavior: "smooth", block: "start" });
                paaNameInput.focus();
            }

            function cancelPaaEdit() {
                editingPaaRecordId = null;
                paaForm.reset();
                paaMonthInput.value = nextMonthKey(dateKey(new Date()).slice(0, 7));
                paaForm.querySelector('button[type="submit"]').textContent = "Registrar no PAA";
                document.getElementById("paa-cancel-edit").hidden = true;
                paaFormStatus.textContent = "Nome, CPF e mês são obrigatórios.";
            }

            async function deletePaaRecord(record) {
                const deleteWarning = record.googleSheetUnlinked
                    ? " A linha antiga, sem vínculo de sincronização, será preservada na planilha."
                    : record.googleSyncedAt ? " A linha correspondente também será removida da planilha Google." : "";
                if (!window.confirm(`Deseja excluir o registro de ${record.nome} de ${paaMonthLabel(record.month)}?${deleteWarning}`)) return;
                if (record.googleSyncedAt && !record.googleSheetUnlinked
                    && !hasGoogleAppsScriptBridge() && !offlineMode) {
                    paaSyncStatus.textContent = window.CRASDesktop
                        ? getGoogleAppsScriptBridgeUrl()
                            ? "Conecte ao Google Sheets nas Configurações antes de excluir este registro sincronizado."
                            : "Configure o URL do Apps Script nas Configurações antes de excluir este registro sincronizado."
                        : "Abra o sistema pelo link do Apps Script para excluir também a linha da planilha. O registro não foi removido.";
                    return;
                }
                if (record.googleSyncedAt && !record.googleSheetUnlinked && hasGoogleAppsScriptBridge()) {
                    try {
                        await callSyncBackend("deletePaaRecordFromSheet", record.id);
                    } catch (error) {
                        console.error("Falha ao excluir um registro do PAA no Google Sheets.", error);
                        paaSyncStatus.textContent = `Não foi possível excluir o registro da planilha: ${error.message}`;
                        return;
                    }
                }
                const updatedRecords = paaRecords.filter(item => item.id !== record.id);
                if (!await saveStorage(STORAGE_PAA_RECORDS, updatedRecords)) {
                    paaSyncStatus.textContent = record.googleSyncedAt
                        ? "A linha foi removida da planilha, mas o histórico local não pôde ser atualizado. Tente excluir novamente."
                        : "Não foi possível excluir o registro neste dispositivo.";
                    return;
                }
                paaRecords = updatedRecords;
                if (editingPaaRecordId === record.id) cancelPaaEdit();
                paaSyncStatus.textContent = record.googleSyncedAt
                    ? offlineMode
                        ? "Registro excluído apenas deste dispositivo. A cópia no Google continua inalterada até uma sincronização futura."
                        : record.googleSheetUnlinked
                        ? "Registro excluído do histórico local; a linha antiga da planilha foi preservada."
                        : "Registro e linha da planilha excluídos."
                    : "Registro excluído do histórico local.";
                renderPaaHistory();
            }

            async function markPaaRecordSynced(recordId) {
                const updatedRecords = paaRecords.map(item => item.id === recordId
                    ? { ...item, googleSyncedAt: new Date().toISOString() }
                    : item);
                if (!await saveStorage(STORAGE_PAA_RECORDS, updatedRecords)) return false;
                paaRecords = updatedRecords;
                return true;
            }

            function hasGoogleAppsScriptBridge() {
                const bridgeUrl = window.CRASDesktop
                    ? getGoogleAppsScriptBridgeUrl()
                    : getSyncBridgeUrl();
                return !offlineMode && Boolean(window.google?.script?.run || bridgeUrl)
                    && (!window.CRASDesktop || Boolean(accessToken));
            }

            async function syncPaaRecord(record) {
                if (!hasGoogleAppsScriptBridge()) {
                    throw new Error("Configure e conecte o Apps Script nas Configurações para sincronizar a planilha.");
                }
                return callSyncBackend("savePaaRecordToSheet", {
                    id: record.id,
                    month: record.month,
                    nome: record.nome,
                    cpf: formatCpf(record.cpf),
                    telefone: formatPhone(record.telefone)
                });
            }

            async function syncPendingPaaRecords() {
                const button = document.getElementById("paa-sync-pending");
                const pendingRecords = paaRecords.filter(record => !record.googleSyncedAt
                    && !record.googleSheetUnlinked);
                if (!pendingRecords.length) return;
                if (!hasGoogleAppsScriptBridge()) {
                    paaSyncStatus.textContent = window.CRASDesktop
                        ? getGoogleAppsScriptBridgeUrl()
                            ? "Conecte ao Google Sheets nas Configurações antes de enviar os pendentes."
                            : "Configure o URL do Apps Script nas Configurações antes de enviar os pendentes."
                        : "Para enviar ao Google, abra o sistema pelo link publicado no Apps Script.";
                    return;
                }
                button.disabled = true;
                let syncedCount = 0;
                const updateProgress = () => {
                    button.textContent = `Enviando ${syncedCount}/${pendingRecords.length}…`;
                    paaSyncStatus.textContent =
                        `Enviando ${syncedCount} de ${pendingRecords.length} registros pendentes para a planilha…`;
                    showSyncStatus(paaSyncStatus.textContent, 0);
                };
                updateProgress();
                for (const record of pendingRecords) {
                    try {
                        await syncPaaRecord(record);
                        if (!await markPaaRecordSynced(record.id)) {
                            paaSyncStatus.textContent = "A planilha recebeu o registro, mas não foi possível salvar a confirmação neste dispositivo. Tente sincronizar novamente.";
                            showSyncStatus(paaSyncStatus.textContent, 0);
                            renderPaaHistory();
                            return;
                        }
                        syncedCount += 1;
                        updateProgress();
                    } catch (error) {
                        console.error("Falha ao sincronizar um registro do PAA com o Google Sheets.", error);
                        paaSyncStatus.textContent = `${syncedCount} registro(s) enviado(s). Não foi possível enviar o registro de ${record.nome}: ${error.message}`;
                        showSyncStatus(paaSyncStatus.textContent, 0);
                        renderPaaHistory();
                        return;
                    }
                }
                paaSyncStatus.textContent = `${syncedCount} ${syncedCount === 1 ? "registro enviado" : "registros enviados"} para a planilha Google.`;
                showSyncStatus(paaSyncStatus.textContent);
                renderPaaHistory();
            }

            function exportSpreadsheet(records, periodLabel, suffix) {
                if (!records.length) {
                    showToast("Não há atendimentos para exportar.");
                    return;
                }
                records = records.flatMap(getServiceRows);
                const columns = [
                    ["Data e hora do atendimento", record => formatDateTime(record.createdAt)],
                    ["Nome", record => record.nome],
                    ["Endereço", record => formattedAddress(record)],
                    ["CPF", record => formatCpf(record.cpf)],
                    ["Telefone", record => formatPhone(record.telefone)],
                    ["Nacionalidade", record => record.nacionalidade ?? record.etnia ?? ""],
                    ["Técnico(s)", record => record.assistente],
                    ["Encaminhamento", record => displayRouteName(record.encaminhamento)]
                ];
                const escapeXml = value => String(value ?? "")
                    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
                    .replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
                const cell = (value, style = "Cell", mergeAcross = "") => `<Cell ss:StyleID="${style}"${mergeAcross}><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
                const headers = columns.map(([label]) => cell(label, "Header")).join("");
                const rows = records.map(record => `<Row ss:AutoFitHeight="1">${columns.map(([, value]) => cell(value(record))).join("")}</Row>`).join("");
                const title = `Atendimento - CRAS Ouro Preto | ${periodLabel}`;
                const worksheet = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:html="http://www.w3.org/TR/REC-html40">
<DocumentProperties xmlns="urn:schemas-microsoft-com:office:office"><Title>${escapeXml(title)}</Title></DocumentProperties>
<Styles>
<Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Arial" ss:Size="10"/></Style>
<Style ss:ID="Title"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Arial" ss:Size="16" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#286B4D" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#1D5139"/></Borders></Style>
<Style ss:ID="Header"><Alignment ss:Vertical="Center" ss:WrapText="1"/><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1D5139" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A8B8AA"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A8B8AA"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A8B8AA"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A8B8AA"/></Borders></Style>
<Style ss:ID="Cell"><Alignment ss:Vertical="Center" ss:WrapText="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C7D1C9"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C7D1C9"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C7D1C9"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C7D1C9"/></Borders></Style>
</Styles>
<Worksheet ss:Name="Atendimentos"><Table ss:ExpandedColumnCount="8" ss:ExpandedRowCount="${records.length + 3}" x:FullColumns="1" x:FullRows="1">
<Column ss:Width="150"/><Column ss:Width="190"/><Column ss:Width="330"/><Column ss:Width="175"/><Column ss:Width="165"/><Column ss:Width="145"/><Column ss:Width="145"/><Column ss:Width="200"/>
<Row ss:Height="32">${cell(title, "Title", " ss:MergeAcross=\"7\"")}</Row><Row ss:Height="10"/><Row ss:Height="32">${headers}</Row>${rows}
</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><PageSetup><Layout x:Orientation="Landscape"/></PageSetup><FitToPage/><Print><ValidPrinterInfo/><PaperSizeIndex>9</PaperSizeIndex><Scale>80</Scale></Print><Selected/><Panes><Pane><Number>3</Number><ActiveRow>3</ActiveRow><ActiveCol>0</ActiveCol></Pane></Panes><ProtectObjects>False</ProtectObjects><ProtectScenarios>False</ProtectScenarios></WorksheetOptions></Worksheet>
</Workbook>`;
                const blob = new Blob(["\uFEFF", worksheet], { type: "application/vnd.ms-excel;charset=utf-8;" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = `atendimentos-${suffix}.xls`;
                document.body.appendChild(link);
                link.click();
                link.remove();
                URL.revokeObjectURL(url);
                document.getElementById("export-menu").hidden = true;
                document.getElementById("export-toggle").setAttribute("aria-expanded", "false");
                showToast(`${records.length} ${records.length === 1 ? "atendimento exportado" : "atendimentos exportados"}.`);
            }

            function downloadJson(filename, data) {
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                link.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }

            function exportBackup() {
                const snapshot = createSyncSnapshot();
                if (!snapshot.settings[STORAGE_TECHNICAL_E2EE]
                    && appointments.some(record => getAnnotationEntries(record, "assistencia").length)) {
                    showToast("Configure a chave técnica antes de exportar anotações sensíveis.", "error");
                    return;
                }
                const backup = {
                    format: BACKUP_FORMAT,
                    version: BACKUP_VERSION,
                    exportedAt: new Date().toISOString(),
                    appointments: snapshot.appointments,
                    technicalE2EE: snapshot.settings[STORAGE_TECHNICAL_E2EE] || null,
                    people,
                    routes,
                    routeQueueTags,
                    nationalities,
                    assistants,
                    users,
                    preferences,
                    paaRecords
                };
                downloadJson(`cras-backup-${dateKey(new Date())}.json`, backup);
                showToast("Backup do histórico, pessoas, anotações e configurações exportado.");
            }

            function validateBackup(backup) {
                if (!backup || backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION || !Array.isArray(backup.appointments) || !Array.isArray(backup.routes)) {
                    throw new Error("O arquivo não é um backup válido desta página.");
                }
                const importedTechnicalE2EE = backup.technicalE2EE ?? null;
                if (importedTechnicalE2EE !== null) {
                    if (!importedTechnicalE2EE || importedTechnicalE2EE.version !== 1) {
                        throw new Error("A configuração de criptografia técnica do backup está inválida.");
                    }
                    validateTechnicalCiphertextEnvelope(importedTechnicalE2EE.keyCheck);
                }
                if (!importedTechnicalE2EE
                    && backup.appointments.some(record => record?.technicalAnnotationsCiphertext)) {
                    throw new Error("O backup contém anotações técnicas cifradas sem a configuração da chave.");
                }
                const importedPeople = backup.people === undefined ? [] : backup.people;
                if (!Array.isArray(importedPeople)) throw new Error("A lista de pessoas do arquivo está inválida.");
                const validatedPeople = importedPeople.map((person, index) => {
                    if (!person || typeof person !== "object"
                        || typeof person.key !== "string" || !person.key.trim()
                        || (person.id !== null && person.id !== undefined
                            && (!Number.isSafeInteger(person.id) || person.id < 1))
                        || typeof person.name !== "string" || !person.name.trim()
                        || typeof person.cpf !== "string" || !/^\d{0,11}$/.test(person.cpf)
                        || typeof person.createdAt !== "string" || Number.isNaN(Date.parse(person.createdAt))) {
                        throw new Error(`O cadastro de pessoa ${index + 1} do arquivo está inválido.`);
                    }
                    return {
                        key: person.key,
                        id: person.id ?? null,
                        name: person.name.trim(),
                        cpf: person.cpf,
                        createdAt: person.createdAt
                    };
                });
                if (new Set(validatedPeople.map(person => person.key)).size !== validatedPeople.length) {
                    throw new Error("O backup contém identificadores de pessoa duplicados.");
                }
                const importedAppointments = backup.appointments.map((record, index) => {
                    if (!record || typeof record !== "object" || Array.isArray(record)) {
                        throw new Error(`O registro ${index + 1} do arquivo é inválido.`);
                    }
                    const annotations = record?.annotations;
                    if (annotations !== undefined && (!annotations || typeof annotations !== "object" || Array.isArray(annotations))) {
                        throw new Error(`As anotações do registro ${index + 1} estão inválidas.`);
                    }
                    const validatedAnnotations = annotations === undefined ? undefined : {};
                    for (const category of ["assistencia", "cadastro"]) {
                        if (annotations === undefined) break;
                        const entries = annotations[category] === undefined ? [] : annotations[category];
                        if (!Array.isArray(entries)) {
                            throw new Error(`As anotações do registro ${index + 1} estão inválidas.`);
                        }
                        validatedAnnotations[category] = entries.map((entry, entryIndex) => {
                            const validDate = value => typeof value === "string" && !Number.isNaN(Date.parse(value));
                            if (!entry || typeof entry !== "object"
                                || typeof entry.id !== "string" || !entry.id.trim()
                                || typeof entry.text !== "string" || !entry.text.trim() || entry.text.length > 6000
                                || typeof entry.authorName !== "string" || !entry.authorName.trim()
                                || !["assistant", "caseworker", "admin"].includes(entry.authorRole)
                                || !validDate(entry.attendanceDate) || !validDate(entry.createdAt)
                                || (entry.updatedAt !== undefined && !validDate(entry.updatedAt))
                                || (entry.updatedBy !== undefined && typeof entry.updatedBy !== "string")) {
                                throw new Error(`A anotação ${entryIndex + 1} do registro ${index + 1} está inválida.`);
                            }
                            return {
                                id: entry.id,
                                text: entry.text,
                                authorName: entry.authorName.trim(),
                                authorRole: entry.authorRole,
                                attendanceDate: entry.attendanceDate,
                                createdAt: entry.createdAt,
                                ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
                                ...(entry.updatedBy !== undefined ? { updatedBy: entry.updatedBy } : {})
                            };
                        });
                    }
                    if (record.technicalAnnotationsCiphertext !== undefined) {
                        validateTechnicalCiphertextEnvelope(record.technicalAnnotationsCiphertext);
                    }
                    if (importedTechnicalE2EE && validatedAnnotations?.assistencia?.length) {
                        throw new Error(`O registro ${index + 1} contém anotações técnicas sem criptografia.`);
                    }
                    if (!record || typeof record !== "object" || typeof record.id !== "string" || !record.id.trim()
                        || typeof record.createdAt !== "string" || Number.isNaN(new Date(record.createdAt).getTime())
                        || typeof record.nome !== "string" || typeof record.cpf !== "string"
                        || typeof record.endereco !== "string" || typeof record.numero !== "string"
                        || typeof record.telefone !== "string" || typeof record.assistente !== "string"
                        || typeof record.encaminhamento !== "string"
                        || (record.encaminhamentos !== undefined
                            && (!Array.isArray(record.encaminhamentos)
                                || record.encaminhamentos.some(route => typeof route !== "string")))
                        || (record.routeServices !== undefined && !Array.isArray(record.routeServices))
                        || (record.cadastradora !== undefined && typeof record.cadastradora !== "string")
                        || (record.personKey !== undefined && (typeof record.personKey !== "string" || !record.personKey.trim()))
                        || (record.personId !== undefined && record.personId !== null
                            && (!Number.isSafeInteger(record.personId) || record.personId < 1))
                        || (record.nacionalidade !== undefined && typeof record.nacionalidade !== "string")
                        || (record.etnia !== undefined && typeof record.etnia !== "string")
                        || (record.tags !== undefined && (!Array.isArray(record.tags) || record.tags.some(tag => typeof tag !== "string")))
                        || ["queueEnteredAt", "cadastroUnicoNaFilaDesde", "assistenciaNaFilaDesde",
                            "cadastroUnicoIniciadaEm", "cadastroUnicoAvisoEm",
                            "assistenciaIniciadaEm", "assistenciaAvisoEm"]
                            .some(key => record[key] !== undefined
                                && (typeof record[key] !== "string" || Number.isNaN(new Date(record[key]).getTime())))
                        || ["cadastroUnicoIniciada", "cadastroUnicoFinalizado",
                            "assistenciaIniciada", "assistenciaFinalizada"]
                            .some(key => record[key] !== undefined && typeof record[key] !== "boolean")) {
                        throw new Error(`O registro ${index + 1} do arquivo está incompleto ou inválido.`);
                    }
                    const routeServices = record.routeServices === undefined ? undefined : record.routeServices.map((service, serviceIndex) => {
                        const validMember = member => member === null || (member && typeof member === "object"
                            && typeof member.name === "string" && typeof member.role === "string"
                            && (member.id === undefined || typeof member.id === "string")
                            && (member.color === undefined || typeof member.color === "string"));
                        if (!service || typeof service !== "object" || typeof service.id !== "string"
                            || !service.id || typeof service.route !== "string" || !service.route
                            || (service.cancelled !== undefined && typeof service.cancelled !== "boolean")
                            || (service.assistanceAcquiredBy !== undefined && !validMember(service.assistanceAcquiredBy))
                            || (service.assistanceAcquiredAt !== undefined
                                && (typeof service.assistanceAcquiredAt !== "string"
                                    || Number.isNaN(Date.parse(service.assistanceAcquiredAt))))
                            || (service.queueTags !== undefined && (!Array.isArray(service.queueTags)
                                || service.queueTags.some(tag => !Object.values(QUEUE_TAGS).includes(tag))))
                            || (service.assignments !== undefined && (!service.assignments
                                || typeof service.assignments !== "object" || Array.isArray(service.assignments)
                                || Object.values(service.assignments).some(member => !validMember(member))))
                            || (service.startedBy !== undefined && !validMember(service.startedBy))
                            || (service.collaborators !== undefined && (!Array.isArray(service.collaborators)
                                || service.collaborators.some(member => !validMember(member))))
                            || (service.states !== undefined && (!service.states || typeof service.states !== "object"
                                || Array.isArray(service.states) || Object.values(service.states).some(state => {
                                    if (!state || typeof state !== "object") return true;
                                    const invalidStatus = ["started", "finished"].some(key =>
                                        state[key] !== undefined && typeof state[key] !== "boolean");
                                    const invalidTimestamp = ["enteredAt", "startedAt", "finishedAt", "reminderAt",
                                        "finishedFollowupAt"].some(key =>
                                        state[key] !== undefined && (typeof state[key] !== "string"
                                            || Number.isNaN(Date.parse(state[key]))));
                                    return invalidStatus || invalidTimestamp
                                        || (state.finishedBy !== undefined && !validMember(state.finishedBy))
                                        || (state.attendedBy !== undefined && !validMember(state.attendedBy));
                                })))) {
                            throw new Error(`O serviço ${serviceIndex + 1} do registro ${index + 1} está inválido.`);
                        }
                        return service;
                    });
                    return {
                        id: record.id,
                        createdAt: record.createdAt,
                        nome: record.nome,
                        cpf: record.cpf,
                        telefone: record.telefone,
                        endereco: record.endereco,
                        numero: record.numero,
                        nacionalidade: record.nacionalidade ?? record.etnia ?? "",
                        assistente: record.assistente,
                        ...(record.cadastradora !== undefined ? { cadastradora: record.cadastradora } : {}),
                        encaminhamento: record.encaminhamento,
                        ...(record.encaminhamentos ? { encaminhamentos: record.encaminhamentos } : {}),
                        ...(routeServices ? { routeServices } : {}),
                        tags: (record.tags || []).map(tag => tag.trim().toLocaleLowerCase("pt-BR")),
                        ...(record.personKey !== undefined ? { personKey: record.personKey } : {}),
                        ...(record.personId !== undefined ? { personId: record.personId } : {}),
                        ...(validatedAnnotations !== undefined ? { annotations: validatedAnnotations } : {}),
                        ...(record.technicalAnnotationsCiphertext
                            ? { technicalAnnotationsCiphertext: record.technicalAnnotationsCiphertext }
                            : {}),
                        ...(["queueEnteredAt", "cadastroUnicoNaFilaDesde", "assistenciaNaFilaDesde",
                            "cadastroUnicoIniciadaEm", "cadastroUnicoAvisoEm",
                            "assistenciaIniciadaEm", "assistenciaAvisoEm"]
                            .filter(key => record[key] !== undefined)
                            .reduce((timestamps, key) => ({ ...timestamps, [key]: record[key] }), {})),
                        ...(record.cadastroUnicoIniciada !== undefined ? { cadastroUnicoIniciada: record.cadastroUnicoIniciada } : {}),
                        ...(record.cadastroUnicoFinalizado !== undefined ? { cadastroUnicoFinalizado: record.cadastroUnicoFinalizado } : {}),
                        ...(record.assistenciaIniciada !== undefined ? { assistenciaIniciada: record.assistenciaIniciada } : {}),
                        ...(record.assistenciaFinalizada !== undefined ? { assistenciaFinalizada: record.assistenciaFinalizada } : {})
                    };
                });
                const importedRoutes = backup.routes.map((route, index) => {
                    if (typeof route !== "string" || !route.trim()) throw new Error(`O encaminhamento ${index + 1} do arquivo está inválido.`);
                    return route.trim();
                });
                const importedRouteQueueTags = {};
                if (backup.routeQueueTags !== undefined) {
                    if (!backup.routeQueueTags || typeof backup.routeQueueTags !== "object" || Array.isArray(backup.routeQueueTags)) {
                        throw new Error("As filas dos encaminhamentos no arquivo estão inválidas.");
                    }
                    Object.entries(backup.routeQueueTags).forEach(([route, tags]) => {
                        const validTags = Array.isArray(tags) && tags.length > 0
                            && tags.every(tag => typeof tag === "string"
                                && [...Object.values(QUEUE_TAGS), QUEUE_TAG_NONE].includes(tag.trim().toLocaleLowerCase("pt-BR")));
                        const normalized = validTags ? [...new Set(tags.map(tag => tag.trim().toLocaleLowerCase("pt-BR")))] : [];
                        if (!route.trim() || !validTags
                            || (normalized.includes(QUEUE_TAG_NONE) && normalized.length > 1)) {
                            throw new Error(`A configuração de fila do encaminhamento “${route}” está inválida.`);
                        }
                        importedRouteQueueTags[route] = normalized;
                    });
                }
                const nationalityList = backup.nationalities === undefined ? backup.ethnicities : backup.nationalities;
                if (nationalityList !== undefined && !Array.isArray(nationalityList)) {
                    throw new Error("A lista de nacionalidades do arquivo está inválida.");
                }
                const importedNationalities = nationalityList === undefined ? [] : nationalityList.map((nationality, index) => {
                    if (typeof nationality !== "string" || !nationality.trim() || nationality.trim().length > 60) {
                        throw new Error(`A nacionalidade ${index + 1} do arquivo está inválida.`);
                    }
                    return nationality.trim();
                });
                let importedAssistants = [];
                if (backup.assistants !== undefined) {
                    if (!Array.isArray(backup.assistants)) throw new Error("A lista de técnicos do arquivo está inválida.");
                    importedAssistants = backup.assistants.map((assistant, index) => {
                        if (!assistant || typeof assistant.name !== "string" || !assistant.name.trim()
                            || assistant.name.trim().length > 60
                            || typeof assistant.color !== "string" || !/^#[0-9a-f]{6}$/i.test(assistant.color)) {
                            throw new Error(`O técnico ${index + 1} do arquivo está inválido.`);
                        }
                        return { name: assistant.name.trim(), color: assistant.color.toLowerCase() };
                    });
                    if (new Set(importedAssistants.map(assistant => assistant.name.toLocaleLowerCase("pt-BR"))).size !== importedAssistants.length) {
                        throw new Error("A lista de técnicos do arquivo contém nomes repetidos.");
                    }
                }
                let importedUsers;
                if (backup.users !== undefined) {
                    if (!Array.isArray(backup.users)) throw new Error("A lista de usuários do arquivo está inválida.");
                    importedUsers = backup.users.map((user, index) => {
                        if (!user || typeof user.id !== "string" || !user.id.trim()
                            || typeof user.name !== "string" || !user.name.trim() || user.name.trim().length > 60
                            || typeof user.color !== "string" || !/^#[0-9a-f]{6}$/i.test(user.color)
                            || (user.canAttendTechnical !== undefined && typeof user.canAttendTechnical !== "boolean")
                            || !["assistant", "caseworker", "reception", "intern", "admin"].includes(user.role)) {
                            throw new Error(`O usuário ${index + 1} do arquivo está inválido.`);
                        }
                        const passwordCredential = user.passwordCredential
                            && typeof user.passwordCredential.salt === "string"
                            && typeof user.passwordCredential.hash === "string"
                            && /^[a-f0-9]{64}$/i.test(user.passwordCredential.hash)
                            ? {
                                salt: user.passwordCredential.salt,
                                hash: user.passwordCredential.hash.toLowerCase()
                            }
                            : null;
                        return {
                            id: user.id,
                            name: user.name.trim(),
                            color: user.color.toLowerCase(),
                            role: user.role,
                            canAttendTechnical: user.role === "admin" && user.canAttendTechnical === true,
                            ...(passwordCredential ? { passwordCredential } : {})
                        };
                    });
                    if (new Set(importedUsers.map(user => user.name.toLocaleLowerCase("pt-BR"))).size !== importedUsers.length) {
                        throw new Error("A lista de usuários do arquivo contém nomes repetidos.");
                    }
                } else {
                    importedUsers = importedAssistants.map((assistant, index) => ({
                        id: `assistant-${index + 1}`,
                        ...assistant,
                        role: "assistant"
                    }));
                }
                const importedPaaRecords = backup.paaRecords === undefined ? [] : backup.paaRecords;
                if (!Array.isArray(importedPaaRecords)) throw new Error("A lista de registros do PAA no arquivo está inválida.");
                const validatedPaaRecords = importedPaaRecords.map((record, index) => {
                    if (!record || typeof record !== "object"
                        || typeof record.id !== "string" || !record.id.trim()
                        || typeof record.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(record.month)
                        || typeof record.nome !== "string" || !record.nome.trim()
                        || typeof record.cpf !== "string" || !/^\d{11}$/.test(record.cpf)
                        || typeof record.telefone !== "string" || !/^\d{0,11}$/.test(record.telefone)
                        || typeof record.nacionalidade !== "string"
                        || typeof record.createdAt !== "string" || Number.isNaN(new Date(record.createdAt).getTime())) {
                        throw new Error(`O registro do PAA ${index + 1} do arquivo está incompleto ou inválido.`);
                    }
                    return { ...record };
                });
                if (new Set(validatedPaaRecords.map(record => `${record.cpf}-${record.month}`)).size !== validatedPaaRecords.length) {
                    throw new Error("O backup contém registros duplicados da mesma pessoa no mesmo mês do PAA.");
                }
                return {
                    importedTechnicalE2EE,
                    importedAppointments,
                    importedPeople: validatedPeople,
                    importedRoutes,
                    importedRouteQueueTags,
                    importedNationalities,
                    importedAssistants,
                    importedUsers,
                    importedPaaRecords: validatedPaaRecords
                };
            }

            async function importBackup(file) {
                if (!file) return;
                try {
                    if (file.size > MAX_BACKUP_FILE_BYTES) {
                        throw new Error("O arquivo de backup excede o limite de 100 MB.");
                    }
                    let backupText;
                    if (file.name.toLocaleLowerCase("pt-BR").endsWith(".json.gz")) {
                        if (typeof DecompressionStream !== "function") {
                            throw new Error("Este navegador não pode abrir backups compactados. Extraia o arquivo .gz e importe o JSON.");
                        }
                        const reader = file.stream()
                            .pipeThrough(new DecompressionStream("gzip"))
                            .getReader();
                        const chunks = [];
                        let totalBytes = 0;
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            totalBytes += value.byteLength;
                            if (totalBytes > MAX_BACKUP_FILE_BYTES) {
                                await reader.cancel();
                                throw new Error("O backup descompactado excede o limite de 100 MB.");
                            }
                            chunks.push(value);
                        }
                        backupText = await new Blob(chunks).text();
                    } else {
                        backupText = await file.text();
                    }
                    const parsed = JSON.parse(backupText);
                    const imported = validateBackup(parsed);
                    const activeTechnicalE2EE = storageCache.get(STORAGE_TECHNICAL_E2EE);
                    if (activeTechnicalE2EE && !imported.importedTechnicalE2EE
                        && imported.importedAppointments.some(record =>
                            getAnnotationEntries(record, "assistencia").length)) {
                        throw new Error("Este sistema exige backup técnico criptografado; o arquivo contém anotações técnicas legíveis.");
                    }
                    if (imported.importedTechnicalE2EE) {
                        if (!activeTechnicalE2EE
                            || JSON.stringify(canonicalSyncValue(activeTechnicalE2EE))
                                !== JSON.stringify(canonicalSyncValue(imported.importedTechnicalE2EE))) {
                            throw new Error("A chave técnica deste backup não corresponde à configuração deste dispositivo. Para recuperar em outro computador, restaure o pacote completo do servidor.");
                        }
                        if (!technicalEncryptionKey || activeUser?.role !== "assistant") {
                            throw new Error("Somente uma Técnica com a chave desbloqueada pode importar um backup técnico criptografado.");
                        }
                        const check = await decryptTechnicalValue(
                            imported.importedTechnicalE2EE.keyCheck,
                            technicalEncryptionKey,
                            "key-check"
                        );
                        if (check !== "CRAS technical annotation key check v1") {
                            throw new Error("A chave técnica atual não pode abrir este backup.");
                        }
                        for (const record of imported.importedAppointments) {
                            if (!record.technicalAnnotationsCiphertext) continue;
                            const entries = await decryptTechnicalValue(
                                record.technicalAnnotationsCiphertext,
                                technicalEncryptionKey,
                                record.id
                            );
                            if (!Array.isArray(entries)) {
                                throw new Error("O backup contém anotações técnicas inválidas.");
                            }
                            record.annotations = {
                                ...getAppointmentAnnotations(record),
                                assistencia: entries
                            };
                            delete record.technicalAnnotationsCiphertext;
                        }
                    }
                    const existingIds = new Set(appointments.map(record => record.id));
                    const mergedAppointments = [...appointments];
                    let added = 0;
                    let matchingAppointments = 0;
                    imported.importedAppointments.forEach(record => {
                        const exactMatchIndex = mergedAppointments.findIndex(existing =>
                            existing.createdAt === record.createdAt
                            && existing.nome === record.nome
                            && existing.cpf === record.cpf
                            && existing.telefone === record.telefone
                            && existing.endereco === record.endereco
                            && existing.numero === record.numero
                            && (existing.nacionalidade ?? existing.etnia ?? "") === record.nacionalidade
                            && existing.assistente === record.assistente
                            && existing.encaminhamento === record.encaminhamento);
                        if (exactMatchIndex !== -1) {
                            mergedAppointments[exactMatchIndex] = { ...record, id: mergedAppointments[exactMatchIndex].id };
                            matchingAppointments += 1;
                            return;
                        }
                        let recordToAdd = record;
                        if (existingIds.has(record.id)) {
                            let id;
                            do {
                                id = window.crypto && crypto.randomUUID
                                    ? crypto.randomUUID()
                                    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
                            } while (existingIds.has(id));
                            recordToAdd = { ...record, id };
                        }
                        existingIds.add(recordToAdd.id);
                        mergedAppointments.push(recordToAdd);
                        added += 1;
                    });
                    const mergedPeople = [...people];
                    const peopleByKey = new Map(mergedPeople.map((person, index) => [person.key, index]));
                    imported.importedPeople.forEach(person => {
                        const existingIndex = peopleByKey.get(person.key);
                        if (existingIndex === undefined) {
                            peopleByKey.set(person.key, mergedPeople.length);
                            mergedPeople.push(person);
                        } else if (!Number.isSafeInteger(mergedPeople[existingIndex].id)
                            && Number.isSafeInteger(person.id)) {
                            mergedPeople[existingIndex] = { ...mergedPeople[existingIndex], id: person.id };
                        }
                    });
                    imported.importedAppointments.forEach(record => {
                        if (typeof record.personKey !== "string" || peopleByKey.has(record.personKey)) return;
                        peopleByKey.set(record.personKey, mergedPeople.length);
                        mergedPeople.push({
                            key: record.personKey,
                            id: Number.isSafeInteger(record.personId) ? record.personId : null,
                            name: record.nome,
                            cpf: record.cpf,
                            createdAt: record.createdAt
                        });
                    });
                    const mergedRoutes = mergeUnique(routes, imported.importedRoutes, route => route);
                    const mergedRouteQueueTags = { ...routeQueueTags };
                    imported.importedRoutes.forEach(route => {
                        if (!Object.hasOwn(mergedRouteQueueTags, route)) {
                            mergedRouteQueueTags[route] = imported.importedRouteQueueTags[route]
                                || DEFAULT_ROUTE_QUEUE_TAGS[route]
                                || [QUEUE_TAG_NONE];
                        }
                    });
                    const importedNationalities = [
                        ...imported.importedNationalities,
                        ...imported.importedAppointments.map(record => record.nacionalidade).filter(Boolean)
                    ];
                    const mergedNationalities = mergeUnique(nationalities, importedNationalities, nationality => nationality);
                    const importUsers = imported.importedUsers.map(user => users.some(existing =>
                        existing.id === user.id && existing.name !== user.name)
                        ? { ...user, id: createUserId() }
                        : user);
                    const mergedUsers = mergeUnique(users, importUsers, user => user.name);
                    const mergedAssistants = mergedUsers.filter(isTechnicalUser)
                        .map(({ name, color }) => ({ name, color }));
                    const mergedPaaRecords = mergeUnique(
                        paaRecords,
                        imported.importedPaaRecords,
                        record => `${record.cpf}-${record.month}`
                    );
                    const newPaaRecords = imported.importedPaaRecords.filter(record =>
                        !paaRecords.some(existing =>
                            existing.cpf === record.cpf && existing.month === record.month));
                    const newRoutes = imported.importedRoutes.filter(route => !routes.includes(route));
                    const newUsers = mergedUsers.length - users.length;
                    const preview = [
                        `Atendimentos: ${imported.importedAppointments.length} no arquivo (${added} novos; ${matchingAppointments} correspondentes).`,
                        `Pessoas: ${imported.importedPeople.length} no arquivo.`,
                        `Registros do PAA: ${imported.importedPaaRecords.length} no arquivo (${newPaaRecords.length} novos).`,
                        `Encaminhamentos: ${newRoutes.length} novos.`,
                        `Usuários: ${newUsers} novos.`,
                        "",
                        "Os dados serão mesclados aos registros deste dispositivo. Deseja continuar?"
                    ].join("\n");
                    if (!window.confirm(`Prévia da importação\n\n${preview}`)) return;
                    if (!await saveImportedStorage(
                        mergedAppointments,
                        mergedPeople,
                        mergedRoutes,
                        mergedAssistants,
                        mergedUsers,
                        mergedNationalities,
                        mergedRouteQueueTags,
                        mergedPaaRecords,
                        imported.importedTechnicalE2EE
                    )) return;
                    appointments = mergedAppointments;
                    people = mergedPeople;
                    routes = mergedRoutes;
                    routeQueueTags = mergedRouteQueueTags;
                    assistants = mergedAssistants;
                    users = mergedUsers;
                    const refreshedActiveUser = users.find(user => user.id === activeUser?.id);
                    if (refreshedActiveUser) activeUser = userSnapshot(refreshedActiveUser);
                    applyActiveUserLayout();
                    nationalities = mergedNationalities;
                    paaRecords = mergedPaaRecords;
                    renderAssistants();
                    renderLoginUsers();
                    renderRoutes();
                    renderNationalities();
                    renderAll();
                    showToast(`Backup importado: ${added} ${added === 1 ? "novo atendimento" : "novos atendimentos"}.`, "success");
                } catch (error) {
                    showToast(error instanceof SyntaxError ? "Não foi possível ler o arquivo. Selecione um backup JSON válido." : error.message || "Não foi possível importar o backup.", "error");
                } finally {
                    document.getElementById("backup-file").value = "";
                }
            }

            function capitalizeInitialLetters(value) {
                return value.replace(/(^|\s)(\p{L})/gu, (match, separator, letter) =>
                    separator + letter.toLocaleUpperCase("pt-BR"));
            }

            function formatCapitalizedInput(input) {
                const selectionStart = input.selectionStart;
                const selectionEnd = input.selectionEnd;
                const originalValue = input.value;
                const formattedValue = capitalizeInitialLetters(originalValue);
                if (formattedValue === originalValue) return;

                input.value = formattedValue;
                if (selectionStart !== null && selectionEnd !== null) {
                    input.setSelectionRange(
                        capitalizeInitialLetters(originalValue.slice(0, selectionStart)).length,
                        capitalizeInitialLetters(originalValue.slice(0, selectionEnd)).length
                    );
                }
            }

            nameInput.addEventListener("input", () => {
                nameInput.value = nameInput.value.replace(/[\p{N}]/gu, "");
                formatCapitalizedInput(nameInput);
                nameInput.setCustomValidity(nameInput.value && /[\p{N}]/u.test(nameInput.value) ? "O nome não pode conter números." : "");
            });
            cpfInput.addEventListener("input", () => formatInputValue(cpfInput, formatCpf, value => value.length === 14 ? "" : "Digite os 11 números do CPF."));
            phoneInput.addEventListener("input", () => formatInputValue(phoneInput, formatPhone, value => {
                const digits = value.replace(/\D/g, "");
                return !digits.length || digits.length === 10 || digits.length === 11 ? "" : "Informe um telefone fixo com 10 dígitos ou celular com 11, incluindo o DDD.";
            }));
            addressInput.addEventListener("input", () => {
                formatCapitalizedInput(addressInput);
                const hasAddress = Boolean(addressInput.value.trim());
                numberInput.required = hasAddress;
                document.getElementById("numero-required").hidden = !hasAddress;
            });
            attachHistoryAutocomplete("nome", nameInput);
            attachHistoryAutocomplete("cpf", cpfInput);
            attachHistoryAutocomplete("telefone", phoneInput);
            attachHistoryAutocomplete("endereco", addressInput);
            bindOptionCarouselSearch(routeCarousel, routeSearchInput, routeSearchEmpty);
            bindOptionCarouselSearch(nationalityCarousel, nationalitySearchInput, nationalitySearchEmpty);
            routeTrigger.addEventListener("click", () => {
                const opening = routeOptions.hidden;
                routeOptions.hidden = !routeOptions.hidden;
                routeTrigger.setAttribute("aria-expanded", String(!routeOptions.hidden));
                if (opening) {
                    routeSearchInput.value = "";
                    filterOptionCarousel(routeCarousel, routeSearchInput, routeSearchEmpty);
                }
            });
            document.getElementById("add-route-button").addEventListener("click", openRouteQueueDialog);
            newRouteInput.addEventListener("keydown", event => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                openRouteQueueDialog();
            });
            routeQueueChoiceInputs.forEach(input => input.addEventListener("change", () => {
                if (input === routeQueueNone && input.checked) {
                    routeQueueAssistance.checked = false;
                    routeQueueCadastro.checked = false;
                } else if (input.checked) {
                    routeQueueNone.checked = false;
                }
                updateRouteQueueConfirmation();
            }));
            confirmRouteQueueButton.addEventListener("click", confirmNewRoute);
            routeQueueOverlay.addEventListener("keydown", event => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    return;
                }
                if (event.key === "Enter") {
                    event.preventDefault();
                    confirmNewRoute();
                    return;
                }
                if (["1", "2", "3"].includes(event.key)) {
                    event.preventDefault();
                    const choice = routeQueueChoiceInputs[Number(event.key) - 1];
                    if (choice === routeQueueNone) {
                        choice.checked = true;
                        routeQueueAssistance.checked = false;
                        routeQueueCadastro.checked = false;
                    } else {
                        choice.checked = !choice.checked;
                        if (choice.checked) routeQueueNone.checked = false;
                    }
                    updateRouteQueueConfirmation();
                    choice.focus();
                    return;
                }
                if (event.key === "Tab") {
                    const focusable = [...routeQueueDialog.querySelectorAll("input:not(:disabled), button:not(:disabled)")];
                    if (!focusable.length) return;
                    const first = focusable[0];
                    const last = focusable[focusable.length - 1];
                    if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last.focus();
                    } else if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first.focus();
                    }
                }
            });
            routeQueueOverlay.addEventListener("click", event => {
                if (event.target === routeQueueOverlay) {
                    routeQueueAssistance.focus();
                }
            });
            document.getElementById("nationality-trigger").addEventListener("click", () => {
                const opening = nationalityOptions.hidden;
                nationalityOptions.hidden = !nationalityOptions.hidden;
                nationalityTrigger.setAttribute("aria-expanded", String(!nationalityOptions.hidden));
                if (opening) {
                    nationalitySearchInput.value = "";
                    filterOptionCarousel(nationalityCarousel, nationalitySearchInput, nationalitySearchEmpty);
                }
            });
            document.getElementById("add-nationality-button").addEventListener("click", async () => {
                const input = document.getElementById("new-nationality");
                const value = input.value.trim();
                if (!value) { input.focus(); return; }
                if (nationalities.some(item => item.toLocaleLowerCase("pt-BR") === value.toLocaleLowerCase("pt-BR"))) {
                    showToast("Essa nacionalidade já está cadastrada.");
                    input.focus();
                    return;
                }
                const updatedNationalities = [...nationalities, value];
                if (!await saveStorage(STORAGE_NATIONALITIES, updatedNationalities)) return;
                nationalities = updatedNationalities;
                renderNationalities();
                setNationalitySelection(value);
                input.value = "";
                input.focus();
            });

            form.addEventListener("input", event => { if (event.isTrusted) lastFormActivityAt = Date.now(); }, true);
            form.addEventListener("change", event => { if (event.isTrusted) lastFormActivityAt = Date.now(); }, true);
            paaMonthInput.value = nextMonthKey(dateKey(new Date()).slice(0, 7));
            paaNameInput.addEventListener("input", () => {
                paaNameInput.value = paaNameInput.value.replace(/[\p{N}]/gu, "");
                formatCapitalizedInput(paaNameInput);
            });
            paaCpfInput.addEventListener("input", () => formatInputValue(paaCpfInput, formatCpf));
            paaPhoneInput.addEventListener("input", () => formatInputValue(paaPhoneInput, formatPhone));
            paaForm.addEventListener("submit", async event => {
                event.preventDefault();
                paaNameInput.value = capitalizeInitialLetters(paaNameInput.value.trim().replace(/\s+/g, " "));
                if (!paaForm.reportValidity()) {
                    paaFormStatus.textContent = "Confira o nome, o CPF e o mês informados.";
                    return;
                }
                const cpf = paaCpfInput.value.replace(/\D/g, "");
                const month = paaMonthInput.value;
                const currentRecord = paaRecords.find(record => record.id === editingPaaRecordId);
                const personRecords = paaRecords.filter(record => record.cpf === cpf && record.id !== editingPaaRecordId);
                if (personRecords.some(record => record.month === month)) {
                    paaFormStatus.textContent = "Esta pessoa já está registrada no PAA para esse mês.";
                    showToast("Já existe um registro dessa pessoa para o mês selecionado.");
                    return;
                }
                const previousMonth = previousMonthKey(month);
                if (!currentRecord && personRecords.some(record => record.month === previousMonth)
                    && !window.confirm(`${paaNameInput.value} recebeu o PAA no mês anterior (${paaMonthLabel(previousMonth)}). Deseja continuar e registrar também em ${paaMonthLabel(month)}?`)) {
                    paaFormStatus.textContent = "O registro não foi incluído.";
                    return;
                }
                const record = {
                    id: currentRecord?.id || (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
                    month,
                    nome: paaNameInput.value,
                    cpf,
                    telefone: paaPhoneInput.value.replace(/\D/g, ""),
                    nacionalidade: document.getElementById("paa-nationality").value.trim(),
                    createdAt: currentRecord?.createdAt || new Date().toISOString(),
                    ...(currentRecord?.googleSheetUnlinked ? { googleSheetUnlinked: true } : {})
                };
                const updatedRecords = currentRecord
                    ? paaRecords.map(item => item.id === currentRecord.id ? record : item)
                    : [...paaRecords, record];
                if (!await saveStorage(STORAGE_PAA_RECORDS, updatedRecords)) return;
                paaRecords = updatedRecords;
                const wasEditing = Boolean(currentRecord);
                cancelPaaEdit();
                paaForm.reset();
                paaMonthInput.value = month;
                paaFormStatus.textContent = wasEditing
                    ? `Alterações salvas para ${paaMonthLabel(month)}.`
                    : `Registro salvo para ${paaMonthLabel(month)}.`;
                renderPaaHistory();
                if (!window.CRASDesktop && record.googleSheetUnlinked) {
                    paaSyncStatus.textContent = "Registro atualizado no histórico sincronizado; a linha antiga e não vinculada da planilha permanece inalterada.";
                } else if (record.googleSheetUnlinked) {
                    paaSyncStatus.textContent = "Registro local atualizado; a linha antiga e não vinculada da planilha permanece inalterada.";
                } else if (hasGoogleAppsScriptBridge()) {
                    try {
                        await syncPaaRecord(record);
                        if (!await markPaaRecordSynced(record.id)) {
                            paaSyncStatus.textContent = "A planilha recebeu as alterações, mas não foi possível salvar a confirmação neste dispositivo. Tente sincronizar novamente.";
                        } else {
                            paaSyncStatus.textContent = wasEditing
                                ? "Alterações atualizadas na planilha Google."
                                : "Registro enviado para a planilha Google.";
                        }
                    } catch (error) {
                        console.error("Falha ao salvar um registro do PAA no Google Sheets.", error);
                        paaSyncStatus.textContent = `Registro salvo localmente, mas não foi possível atualizar a planilha: ${error.message}`;
                    }
                    renderPaaHistory();
                }
                paaNameInput.focus();
            });
            document.getElementById("paa-cancel-edit").addEventListener("click", cancelPaaEdit);
            form.addEventListener("input", scheduleAppointmentDraftSave);
            form.addEventListener("change", scheduleAppointmentDraftSave);
            document.getElementById("appointment-draft-restore").addEventListener("click", () => {
                restoreAppointmentDraft().catch(error => {
                    console.error("Não foi possível restaurar o rascunho do atendimento.", error);
                    showToast("Não foi possível restaurar o rascunho salvo.");
                });
            });
            document.getElementById("appointment-draft-discard").addEventListener("click", () => {
                discardAppointmentDraft().catch(error => {
                    console.error("Não foi possível descartar o rascunho do atendimento.", error);
                    showToast("Não foi possível descartar o rascunho salvo.");
                });
            });
            queueFollowupNo.addEventListener("click", () => answerQueuePrompt(false));
            queueFollowupYes.addEventListener("click", () => answerQueuePrompt(true));
            queueFollowupOverlay.addEventListener("keydown", event => {
                if (event.key !== "Tab") return;
                const controls = [queueFollowupNo, queueFollowupYes];
                const first = controls[0];
                const last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            });

            form.addEventListener("submit", async event => {
                event.preventDefault();
                await refreshCurrentDay();
                nameInput.value = capitalizeInitialLetters(nameInput.value.trim().replace(/\s+/g, " "));
                addressInput.value = capitalizeInitialLetters(addressInput.value.trim());
                numberInput.value = numberInput.value.trim();
                const selectedAssistant = form.querySelector("input[name='assistente']:checked");
                const selectedRoutes = getSelectedRoutes();
                updateAssistantRequirement();
                if (!form.reportValidity()) {
                    formStatus.textContent = selectedRoutes.some(route =>
                        getRouteQueueTags(route).includes(QUEUE_TAGS.assistencia)) && !selectedAssistant
                        ? "Selecione um Técnico para o encaminhamento Atendimento Técnico."
                        : "Confira os campos obrigatórios e os formatos indicados.";
                    return;
                }
                if (!selectedRoutes.length) {
                    routeOptions.hidden = false;
                    routeTrigger.setAttribute("aria-expanded", "true");
                    formStatus.textContent = "Selecione ao menos um encaminhamento para salvar.";
                    routeTrigger.focus();
                    return;
                }
                const appointmentDate = new Date(appointmentDateInput.value);
                if (Number.isNaN(appointmentDate.getTime())) {
                    formStatus.textContent = "Informe uma data e hora válidas para o atendimento.";
                    appointmentDateInput.focus();
                    return;
                }
                const appointmentTimestamp = appointmentDate.toISOString();
                const currentRecord = editingAppointmentId
                    ? appointments.find(record => record.id === editingAppointmentId)
                    : null;
                const currentTags = Array.isArray(currentRecord?.tags) ? currentRecord.tags : [];
                const otherTags = currentTags.filter(tag => typeof tag === "string"
                    && ![...Object.values(QUEUE_TAGS), QUEUE_TAG_NONE].includes(tag.trim().toLocaleLowerCase("pt-BR")));
                const isStaffManualRecord = ["assistant", "caseworker"].includes(activeUser?.role)
                    && !editingAppointmentId;
                const queueNow = isStaffManualRecord ? appointmentTimestamp : new Date().toISOString();
                const existingServices = currentRecord
                    ? Array.isArray(currentRecord.routeServices)
                        ? currentRecord.routeServices
                        : getRecordServices(currentRecord)
                    : [];
                const hasTechnicalRoute = selectedRoutes.some(route =>
                    getRouteQueueTags(route).includes(QUEUE_TAGS.assistencia));
                const hasCadastroRoute = selectedRoutes.some(route =>
                    getRouteQueueTags(route).includes(QUEUE_TAGS.cadastro));
                const assistantUser = hasTechnicalRoute
                    ? activeUser?.role === "assistant"
                        ? activeUser
                        : selectedAssistant
                            ? users.find(user => isTechnicalUser(user) && user.name === selectedAssistant.value)
                            : null
                    : null;
                const caseworkerUser = hasCadastroRoute
                    ? activeUser?.role === "caseworker"
                        ? activeUser
                        : users.find(user => user.role === "caseworker" && user.id === caseworkerAssignment.value)
                    : null;
                let routeServices = existingServices.map(service => {
                    if (!selectedRoutes.includes(service.route)) return { ...service, cancelled: true };
                    const queueTags = getRouteQueueTags(service.route).filter(tag => tag !== QUEUE_TAG_NONE);
                    const states = { ...(service.states || {}) };
                    queueTags.forEach(tag => {
                        const queueType = tag === QUEUE_TAGS.cadastro ? "cadastro" : "assistencia";
                        if (!states[queueType]) {
                            states[queueType] = {
                                started: false,
                                finished: false,
                                enteredAt: queueNow,
                                startedAt: "",
                                finishedAt: ""
                            };
                        }
                    });
                    const assignments = { ...(service.assignments || {}) };
                    if (queueTags.includes(QUEUE_TAGS.assistencia)) {
                        assignments.assistencia = userSnapshot(assistantUser);
                    } else {
                        delete assignments.assistencia;
                    }
                    if (queueTags.includes(QUEUE_TAGS.cadastro)) {
                        assignments.cadastro = userSnapshot(caseworkerUser);
                    } else {
                        delete assignments.cadastro;
                    }
                    return {
                        ...service,
                        cancelled: false,
                        queueTags,
                        states,
                        assignments
                    };
                });
                selectedRoutes.forEach(route => {
                    if (routeServices.some(service => service.route === route && service.cancelled !== true)) return;
                    const queueTags = getRouteQueueTags(route).filter(tag => tag !== QUEUE_TAG_NONE);
                    const states = {};
                    queueTags.forEach(tag => {
                        const queueType = tag === QUEUE_TAGS.cadastro ? "cadastro" : "assistencia";
                        states[queueType] = {
                            started: false,
                            finished: false,
                            enteredAt: queueNow,
                            startedAt: "",
                            finishedAt: ""
                        };
                    });
                    const assignments = {};
                    if (queueTags.includes(QUEUE_TAGS.assistencia)) {
                        assignments.assistencia = userSnapshot(assistantUser);
                    }
                    if (queueTags.includes(QUEUE_TAGS.cadastro)) {
                        assignments.cadastro = userSnapshot(caseworkerUser);
                    }
                    routeServices.push({
                        id: createUserId(),
                        route,
                        queueTags,
                        assignments,
                        startedBy: null,
                        collaborators: [],
                        states
                    });
                });
                if (isStaffManualRecord) {
                    const attendingUser = userSnapshot(activeUser);
                    routeServices = routeServices.map(service => ({
                        ...service,
                        startedBy: attendingUser,
                        states: Object.fromEntries(Object.entries(service.states || {}).map(([type, state]) => [
                            type,
                            {
                                ...state,
                                started: true,
                                finished: true,
                                enteredAt: state.enteredAt || appointmentTimestamp,
                                startedAt: appointmentTimestamp,
                                finishedAt: appointmentTimestamp,
                                finishedBy: attendingUser
                            }
                        ]))
                    }));
                }
                const activeServices = routeServices.filter(service => service.cancelled !== true);
                const recordData = {
                    id: editingAppointmentId || (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
                    createdAt: appointmentTimestamp,
                    nome: nameInput.value,
                    cpf: cpfInput.value.replace(/\D/g, ""),
                    telefone: phoneInput.value.replace(/\D/g, ""),
                    endereco: addressInput.value,
                    numero: numberInput.value,
                    nacionalidade: nationalityValue.value,
                    assistente: assistantUser?.name || "",
                    cadastradora: caseworkerUser?.name || "",
                    encaminhamentos: activeServices.map(service => service.route),
                    encaminhamento: activeServices.map(service => service.route).join(", "),
                    routeServices,
                    tags: [...otherTags, ...new Set(activeServices.flatMap(service => service.queueTags))]
                };
                const resolvedPerson = resolvePersonForAppointment(recordData, currentRecord);
                const updatedPerson = {
                    ...resolvedPerson.person,
                    name: recordData.nome,
                    cpf: recordData.cpf
                };
                recordData.personKey = updatedPerson.key;
                recordData.personId = Number.isSafeInteger(updatedPerson.id) ? updatedPerson.id : null;
                const nextPeople = resolvedPerson.isNew
                    ? [...people.filter(person => person.key !== updatedPerson.key), updatedPerson]
                    : people.map(person => person.key === updatedPerson.key ? updatedPerson : person);
                let previousRecord = null;
                let nextAppointments = appointments;
                if (editingAppointmentId) {
                    const index = appointments.findIndex(record => record.id === editingAppointmentId);
                    if (index === -1) {
                        showToast("Não foi possível localizar o atendimento para atualizar.");
                        return;
                    }
                    previousRecord = { ...appointments[index] };
                    const updatedRecord = { ...previousRecord, ...recordData };
                    if (updatedRecord.createdAt !== previousRecord.createdAt
                        && previousRecord.annotations && typeof previousRecord.annotations === "object") {
                        updatedRecord.annotations = Object.fromEntries(
                            Object.entries(previousRecord.annotations).map(([category, entries]) => [
                                category,
                                Array.isArray(entries)
                                    ? entries.map(entry => entry && typeof entry === "object"
                                        ? { ...entry, attendanceDate: updatedRecord.createdAt } : entry)
                                    : entries
                            ])
                        );
                    }
                    delete updatedRecord.etnia;
                    nextAppointments = appointments.map((record, recordIndex) =>
                        recordIndex === index ? updatedRecord : record);
                } else {
                    nextAppointments = [...appointments, recordData];
                }
                if (!await saveAppointmentAndPeople(nextAppointments, nextPeople)) return;
                appointments = nextAppointments;
                people = nextPeople;
                if (!editingAppointmentId) {
                    try {
                        const draftKey = appointmentDraftKey();
                        if (draftKey) await database.settings.delete(draftKey);
                        document.getElementById("appointment-draft-controls").hidden = true;
                        document.getElementById("appointment-draft-saved").hidden = true;
                    } catch (error) {
                        console.error("O atendimento foi salvo, mas não foi possível remover o rascunho.", error);
                        showToast("Atendimento salvo; descarte o rascunho antigo para evitar restaurá-lo depois.");
                    }
                }
                if (previousRecord) setHistoryUndoAction({ type: "edit", record: previousRecord });
                const successText = editingAppointmentId
                    ? `Atendimento atualizado às ${formatDateTime(recordData.createdAt)}.`
                    : `Atendimento salvo às ${formatDateTime(recordData.createdAt)}. ID da pessoa: ${recordData.personId || "aguardando sincronização"}.`;
                resetFormState();
                if (["assistant", "caseworker"].includes(activeUser?.role)) {
                    formTitle.textContent = "Registrar atendimento manual";
                }
                formStatus.textContent = successText;
                renderAll();
                nameInput.focus();
            });

            document.querySelectorAll(".filter-panel input, .filter-panel select").forEach(control => {
                control.addEventListener("input", () => {
                    historyPage = 0;
                    renderHistory();
                });
                control.addEventListener("change", () => {
                    historyPage = 0;
                    renderHistory();
                });
            });
            document.getElementById("quick-new-appointment").addEventListener("click", () => {
                selectMainTab("attendance");
                nameInput.focus();
            });
            document.getElementById("quick-open-queues").addEventListener("click", () => {
                selectMainTab("queues");
                queuesTab.focus();
            });
            document.getElementById("dashboard-customize-toggle").addEventListener("click", () => {
                if (document.getElementById("dashboard-customizer").hidden) openDashboardCustomizer();
                else closeDashboardCustomizer();
            });
            document.getElementById("dashboard-customizer-close").addEventListener("click", () => closeDashboardCustomizer());
            document.getElementById("dashboard-customizer-list").addEventListener("change", event => {
                const checkbox = event.target.closest("[data-dashboard-visible]");
                if (!checkbox || !dashboardLayoutDraft) return;
                const widgetId = checkbox.dataset.dashboardVisible;
                const visible = new Set(dashboardLayoutDraft.visible);
                if (checkbox.checked) visible.add(widgetId);
                else visible.delete(widgetId);
                dashboardLayoutDraft.visible = [...visible];
            });
            document.getElementById("dashboard-customizer-list").addEventListener("click", event => {
                const moveButton = event.target.closest("[data-dashboard-move]");
                if (!moveButton || !dashboardLayoutDraft) return;
                const index = dashboardLayoutDraft.order.indexOf(moveButton.dataset.widgetId);
                const offset = moveButton.dataset.dashboardMove === "up" ? -1 : 1;
                const targetIndex = index + offset;
                if (index < 0 || targetIndex < 0 || targetIndex >= dashboardLayoutDraft.order.length) return;
                [dashboardLayoutDraft.order[index], dashboardLayoutDraft.order[targetIndex]] =
                    [dashboardLayoutDraft.order[targetIndex], dashboardLayoutDraft.order[index]];
                renderDashboardCustomizer();
                document.querySelector(`[data-dashboard-move="${moveButton.dataset.dashboardMove}"][data-widget-id="${moveButton.dataset.widgetId}"]`)?.focus();
            });
            document.getElementById("dashboard-customizer-save").addEventListener("click", () => {
                if (dashboardLayoutDraft) saveDashboardLayout(dashboardLayoutDraft);
            });
            document.getElementById("dashboard-customizer-reset").addEventListener("click", () => {
                const defaults = createDefaultDashboardLayout();
                dashboardLayoutDraft = defaults;
                renderDashboardCustomizer();
                if (saveDashboardLayout(defaults)) {
                    dashboardLayoutDraft = {
                        version: defaults.version,
                        visible: [...defaults.visible],
                        order: [...defaults.order]
                    };
                    renderDashboardCustomizer();
                    document.getElementById("dashboard-customizer-status").textContent =
                        "Painel padrão restaurado e salvo neste dispositivo.";
                }
            });
            document.getElementById("history-filter-presets").addEventListener("change", event => {
                const preset = historyFilterPresets.find(item => item.id === event.currentTarget.value);
                if (preset) applyHistoryFilterPreset(preset);
                document.getElementById("delete-history-filter").disabled = !preset;
            });
            document.getElementById("save-history-filter").addEventListener("click", async () => {
                const name = window.prompt("Dê um nome para este conjunto de filtros:");
                if (!name?.trim()) return;
                if (historyFilterPresets.length >= 20) {
                    showToast("Você pode salvar até 20 filtros. Exclua um antes de adicionar outro.");
                    return;
                }
                const normalizedName = name.trim().slice(0, 40);
                if (historyFilterPresets.some(preset =>
                    preset.name.toLocaleLowerCase("pt-BR") === normalizedName.toLocaleLowerCase("pt-BR"))) {
                    showToast("Já existe um filtro salvo com esse nome.");
                    return;
                }
                const id = window.crypto?.randomUUID
                    ? crypto.randomUUID()
                    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
                historyFilterPresets = [...historyFilterPresets, {
                    id,
                    name: normalizedName,
                    values: getCurrentHistoryFilterValues()
                }];
                try {
                    await persistHistoryFilterPresets();
                    document.getElementById("history-filter-presets").value = id;
                    document.getElementById("delete-history-filter").disabled = false;
                    showToast("Filtros salvos neste dispositivo.");
                } catch (error) {
                    console.error("Não foi possível salvar os filtros do histórico.", error);
                    showToast("Não foi possível salvar os filtros neste dispositivo.");
                }
            });
            document.getElementById("delete-history-filter").addEventListener("click", async () => {
                const select = document.getElementById("history-filter-presets");
                const selectedId = select.value;
                if (!selectedId) return;
                historyFilterPresets = historyFilterPresets.filter(preset => preset.id !== selectedId);
                try {
                    await persistHistoryFilterPresets();
                    showToast("Filtro salvo excluído.");
                } catch (error) {
                    console.error("Não foi possível excluir o filtro salvo.", error);
                    showToast("Não foi possível excluir o filtro salvo.");
                }
            });
            document.getElementById("history-previous-page").addEventListener("click", () => {
                if (historyPage === 0) return;
                historyPage -= 1;
                renderHistory();
            });
            document.getElementById("history-next-page").addEventListener("click", () => {
                historyPage += 1;
                renderHistory();
            });
            staffHistorySearch.addEventListener("input", () => {
                staffHistoryPage = 0;
                renderStaffHistory();
            });
            document.getElementById("staff-history-previous-page").addEventListener("click", () => {
                if (staffHistoryPage === 0) return;
                staffHistoryPage -= 1;
                renderStaffHistory();
            });
            document.getElementById("staff-history-next-page").addEventListener("click", () => {
                staffHistoryPage += 1;
                renderStaffHistory();
            });
            document.getElementById("report-generate").addEventListener("click", generateCustomReport);
            document.getElementById("report-export-ods").addEventListener("click", exportCustomReportToOds);
            document.getElementById("history-undo").addEventListener("click", undoHistoryAction);
            document.addEventListener("keydown", event => {
                if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.repeat) return;
                const target = event.target;
                if (target instanceof HTMLElement
                    && (target.isContentEditable || target.matches("input, textarea, select, [role='textbox']"))) return;
                if (!document.getElementById("user-login").hidden
                    || !document.getElementById("accessibility-menu").hidden
                    || !document.getElementById("tutorial-card").hidden
                    || !chatPanel.hidden) return;
                const shortcut = event.key.toLocaleLowerCase("en-US");
                if (shortcut === "f" && !attendancePanel.hidden) {
                    event.preventDefault();
                    selectMainTab("attendance");
                    document.getElementById("filter-name").focus();
                } else if (shortcut === "n" && !attendanceTab.hidden) {
                    event.preventDefault();
                    selectMainTab("attendance");
                    nameInput.focus();
                } else if (shortcut === "q" && !queuesTab.hidden) {
                    event.preventDefault();
                    selectMainTab("queues");
                    queuesTab.focus();
                }
            });
            document.addEventListener("keydown", event => {
                if (event.key !== "Tab") return;
                const dialogs = [...document.querySelectorAll(
                    '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'
                )].filter(dialog => dialog.getClientRects().length);
                const dialog = dialogs[dialogs.length - 1];
                if (!dialog) return;
                const focusable = [...dialog.querySelectorAll(
                    'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
                )].filter(element => element.getClientRects().length);
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (!dialog.contains(document.activeElement)) {
                    event.preventDefault();
                    first.focus();
                } else if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            });
            document.getElementById("clear-filters").addEventListener("click", () => {
                document.querySelectorAll(".filter-panel input, .filter-panel select").forEach(control => { control.value = ""; });
                historyPage = 0;
                renderHistory();
                document.getElementById("filter-date").focus();
            });

            const exportMenu = document.getElementById("export-menu");
            const exportToggle = document.getElementById("export-toggle");
            exportToggle.addEventListener("click", () => {
                exportMenu.hidden = !exportMenu.hidden;
                exportToggle.setAttribute("aria-expanded", String(!exportMenu.hidden));
            });
            document.getElementById("export-latest").addEventListener("click", () => {
                const latestDate = [...appointments].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
                if (latestDate) {
                    const date = dateKey(latestDate.createdAt);
                    const label = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date(`${date}T12:00:00`));
                    exportSpreadsheet(appointments.filter(record => dateKey(record.createdAt) === date), label, date);
                }
            });
            document.getElementById("export-selected").addEventListener("click", () => {
                const date = document.getElementById("export-date").value;
                const label = date ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date(`${date}T12:00:00`)) : "Dia selecionado";
                exportSpreadsheet(appointments.filter(record => dateKey(record.createdAt) === date), label, date || "dia");
            });
            document.getElementById("export-month-selected").addEventListener("click", () => {
                const month = document.getElementById("export-month").value;
                if (!month) return;
                const label = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(new Date(`${month}-01T12:00:00`));
                const records = appointments
                    .filter(record => dateKey(record.createdAt).slice(0, 7) === month)
                    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
                exportSpreadsheet(records, label, month);
            });
            document.getElementById("export-all").addEventListener("click", () => exportSpreadsheet([...appointments].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)), "Todos os dias", "todos-os-dias"));
            document.getElementById("backup-export").addEventListener("click", exportBackup);
            const backupFile = document.getElementById("backup-file");
            document.getElementById("backup-import").addEventListener("click", () => backupFile.click());
            backupFile.addEventListener("change", async () => importBackup(backupFile.files[0]));
            const serverTransferFile = document.getElementById("server-transfer-file");
            const serverTransferStatus = document.getElementById("server-transfer-status");
            document.getElementById("server-transfer-export").addEventListener("click", async event => {
                const button = event.currentTarget;
                button.disabled = true;
                serverTransferStatus.textContent = "Preparando uma cópia consistente do servidor…";
                try {
                    const response = await fetchPeer("/api/server-transfer/export", { cache: "no-store" }, 120000);
                    if (!response.ok) {
                        const result = await response.json();
                        throw new Error(result.error || "Não foi possível exportar o servidor.");
                    }
                    const blob = await response.blob();
                    const link = document.createElement("a");
                    const url = URL.createObjectURL(blob);
                    link.href = url;
                    link.download = `cras-server-transfer-${dateKey(new Date())}.sqlite3`;
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                    serverTransferStatus.textContent =
                        "Pacote exportado. Copie-o para uma mídia externa protegida antes de iniciar a troca do servidor.";
                } catch (error) {
                    console.error("Não foi possível exportar o pacote de transferência do servidor.", error);
                    serverTransferStatus.textContent = `Falha ao exportar o servidor: ${error.message}`;
                } finally {
                    button.disabled = false;
                }
            });
            document.getElementById("server-transfer-import").addEventListener("click", () => serverTransferFile.click());
            serverTransferFile.addEventListener("change", async () => {
                const file = serverTransferFile.files[0];
                if (!file) return;
                try {
                    if (file.size > 256 * 1024 * 1024) {
                        throw new Error("O pacote excede o limite de 256 MB.");
                    }
                    const confirmed = window.confirm(
                        "Restaurar este pacote substituirá o armazenamento deste computador por uma cópia completa do servidor, incluindo credenciais e conversas. Use somente uma cópia confiável e não sobrescreva dados locais que ainda não foram sincronizados. Continuar?"
                    );
                    if (!confirmed) return;
                    serverTransferStatus.textContent = "Validando e restaurando o pacote…";
                    const response = await fetchPeer("/api/server-transfer/import", {
                        method: "POST",
                        headers: { "Content-Type": "application/vnd.sqlite3" },
                        body: file
                    }, 120000);
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || "Não foi possível restaurar o servidor.");
                    await database.transaction("rw", database.appointments, database.settings, async () => {
                        await database.appointments.clear();
                        await database.settings.bulkDelete([
                            STORAGE_PEOPLE,
                            STORAGE_PAA_RECORDS,
                            STORAGE_SYNC_BASE,
                            STORAGE_PEER_SYNC_BASES,
                            STORAGE_LOCAL_NODE_REVISION,
                            STORAGE_LOCAL_NODE_BASE_SNAPSHOT
                        ]);
                    });
                    serverTransferStatus.textContent =
                        "Servidor restaurado. O aplicativo será reiniciado para carregar os dados importados.";
                    showToast("Pacote do servidor restaurado. Reiniciando…");
                    window.setTimeout(() => window.location.reload(), 1800);
                } catch (error) {
                    console.error("Não foi possível restaurar o pacote de transferência do servidor.", error);
                    serverTransferStatus.textContent = `Falha ao restaurar o servidor: ${error.message}`;
                } finally {
                    serverTransferFile.value = "";
                }
            });
            document.getElementById("accessibility-toggle").addEventListener("click", () => {
                const menu = document.getElementById("accessibility-menu");
                if (menu.hidden) {
                    menu.hidden = false;
                    requestAnimationFrame(() => menu.classList.add("is-open"));
                    document.getElementById("accessibility-toggle").setAttribute("aria-expanded", "true");
                    document.getElementById("settings-close").focus();
                } else {
                    closeSettingsScreen();
                }
            });
            function closeSettingsScreen(returnFocus = true) {
                const menu = document.getElementById("accessibility-menu");
                menu.classList.remove("is-open");
                document.getElementById("accessibility-toggle").setAttribute("aria-expanded", "false");
                window.setTimeout(() => {
                    if (!menu.classList.contains("is-open")) menu.hidden = true;
                }, preferences.reduceMotion ? 0 : 400);
                if (returnFocus) document.getElementById("accessibility-toggle").focus();
            }
            document.getElementById("settings-close").addEventListener("click", () => closeSettingsScreen());
            document.getElementById("theme-toggle").addEventListener("change", async event => updatePreferences({ darkMode: event.target.checked }));
            document.getElementById("contrast-toggle").addEventListener("change", async event =>
                updatePreferences({ highContrast: event.target.checked }));
            document.getElementById("motion-toggle").addEventListener("change", async event =>
                updatePreferences({ reduceMotion: event.target.checked }));
            document.getElementById("color-theme").addEventListener("change", async event =>
                updatePreferences({ colorTheme: event.target.value }));
            document.getElementById("font-size").addEventListener("change", async event => updatePreferences({ fontScale: event.target.value }));
            document.getElementById("hints-toggle").addEventListener("change", async event => updatePreferences({ showHints: event.target.checked }));
            document.getElementById("sync-messages-toggle").addEventListener("change", async event => {
                const enabled = event.target.checked;
                if (!await updatePreferences({ showSyncMessages: enabled })) return;
                if (!enabled) {
                    document.getElementById("sync-status").hidden = true;
                    window.clearTimeout(syncStatusTimer);
                }
            });
            document.getElementById("history-autocomplete-toggle").addEventListener("change", async event =>
                updatePreferences({ autoCompleteHistory: event.target.checked }));
            document.getElementById("paa-enabled-toggle").addEventListener("change", async event =>
                updatePreferences({ paaEnabled: event.target.checked }));
            document.getElementById("principal-computer-toggle").addEventListener("change", async event => {
                const enabled = event.target.checked;
                if (!await updatePreferences({ isPrincipalComputer: enabled })) return;
                try {
                    await configureAutomaticBackup(enabled);
                    await refreshAutomaticBackupStatus();
                    showToast(enabled
                        ? "Backup diário ativado neste PC Principal."
                        : "Backup automático desativado neste computador.");
                } catch (error) {
                    console.error("Não foi possível atualizar o backup automático.", error);
                    await updatePreferences({ isPrincipalComputer: !enabled });
                    document.getElementById("principal-backup-status").textContent =
                        `Não foi possível configurar o backup automático: ${error.message}`;
                }
            });
            document.getElementById("user-login-form").addEventListener("submit", event => {
                loginSelectedUser(event).catch(error => {
                    console.error("Falha ao autenticar o usuário selecionado.", error);
                    document.getElementById("user-login-status").textContent =
                        "Não foi possível validar o acesso. Verifique o ambiente local e tente novamente.";
                });
            });
            document.getElementById("remember-user-session").addEventListener("change", event => {
                const checkbox = event.currentTarget;
                const previousValue = !checkbox.checked;
                persistRememberUserSessionPreference(checkbox.checked).catch(error => {
                    console.error("Não foi possível salvar a preferência de usuário local.", error);
                    checkbox.checked = previousValue;
                    document.getElementById("user-login-status").textContent =
                        "Não foi possível salvar a preferência neste computador.";
                });
            });
            document.getElementById("login-server-password-toggle").addEventListener("click", () => {
                loginServerPasswordMode = !loginServerPasswordMode;
                document.getElementById("login-password").value = "";
                document.getElementById("login-password-confirm").value = "";
                document.getElementById("user-login-status").textContent = "";
                updateLoginPasswordFields();
                document.getElementById("login-password").focus();
            });
            document.getElementById("login-user").addEventListener("input", event => {
                const enteredName = event.target.value.trim().toLocaleLowerCase("pt-BR");
                const selectedUser = users.find(user => user.name.toLocaleLowerCase("pt-BR") === enteredName);
                if (selectedUser) document.getElementById("login-role").value = selectedUser.role;
                loginServerPasswordMode = Boolean(
                    selectedUser && !selectedUser.passwordCredential && window.CRASDesktop
                );
                updateLoginPasswordFields();
                if (!document.getElementById("user-login-status").textContent.startsWith("Não foi possível")) {
                    document.getElementById("user-login-status").textContent = "";
                }
            });
            document.getElementById("login-role").addEventListener("change", () => {
                const enteredName = document.getElementById("login-user").value.trim().toLocaleLowerCase("pt-BR");
                const selectedRole = document.getElementById("login-role").value;
                const selectedUser = users.find(user =>
                    user.name.toLocaleLowerCase("pt-BR") === enteredName && user.role === selectedRole);
                loginServerPasswordMode = Boolean(
                    selectedUser && !selectedUser.passwordCredential && window.CRASDesktop
                );
                updateLoginPasswordFields();
            });
            document.getElementById("settings-switch-user").addEventListener("click", () => {
                closeSettingsScreen(false);
                showUserLogin();
            });
            attendanceTab.addEventListener("click", () => selectMainTab("attendance"));
            paaTab.addEventListener("click", () => selectMainTab("paa"));
            queuesTab.addEventListener("click", () => selectMainTab("queues"));
            chatToggle.addEventListener("click", () => setChatPopupOpen(chatPanel.hidden));
            document.getElementById("chat-close").addEventListener("click", () => setChatPopupOpen(false));
            document.getElementById("chat-conversation-list").addEventListener("click", event => {
                const button = event.target.closest("[data-chat-kind]");
                if (!button) return;
                document.getElementById("chat-conversation-type").value = button.dataset.chatKind;
                document.getElementById("chat-recipient-id").value = button.dataset.chatRecipient;
                chatRecipientId = button.dataset.chatRecipient;
                chatMessages = [];
                renderChatRecipients();
                renderChatMessages();
                void loadChatMessages("", true);
                document.getElementById("chat-message-input").focus();
            });
            document.getElementById("chat-conversation-search").addEventListener("input", () => {
                renderChatRecipients();
            });
            document.addEventListener("keydown", event => {
                if (event.key === "Escape" && !chatPanel.hidden) setChatPopupOpen(false);
            });
            document.getElementById("chat-form").addEventListener("submit", submitChatMessage);
            document.getElementById("chat-conversation-type").addEventListener("change", () => {
                if (document.getElementById("chat-conversation-type").value !== "direct") {
                    chatRecipientId = "";
                }
                chatMessages = [];
                renderChatRecipients();
                renderChatMessages();
                void loadChatMessages("", true);
            });
            document.getElementById("chat-recipient-id").addEventListener("change", event => {
                chatRecipientId = event.currentTarget.value;
                chatMessages = [];
                renderChatRecipients();
                renderChatMessages();
                void loadChatMessages("", true);
            });
            document.getElementById("chat-message-input").addEventListener("keydown", event => {
                if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form.requestSubmit();
                }
            });
            document.getElementById("chat-person-search").addEventListener("input", renderChatPersonSuggestions);
            document.getElementById("chat-person-suggestions").addEventListener("click", event => {
                const button = event.target.closest("[data-person-id]");
                if (!button) return;
                const record = appointments.find(item => item.id === button.dataset.personId);
                if (!record) return;
                const cpfDigits = (record.cpf || "").replace(/\D/g, "");
                chatPerson = {
                    id: record.id,
                    name: record.nome,
                    cpfMasked: cpfDigits ? `***.***.***-${cpfDigits.slice(-2)}` : ""
                };
                document.getElementById("chat-selected-person-label").textContent =
                    `Pessoa vinculada: ${chatPerson.name}${chatPerson.cpfMasked ? ` · CPF ${chatPerson.cpfMasked}` : ""}`;
                document.getElementById("chat-selected-person").hidden = false;
                document.getElementById("chat-person-suggestions").hidden = true;
                document.getElementById("chat-person-search").value = "";
            });
            document.getElementById("chat-clear-person").addEventListener("click", clearChatPerson);
            document.getElementById("chat-attachment-input").addEventListener("change", async event => {
                const file = event.target.files?.[0];
                if (!file) return;
                try {
                    chatAttachment = await readChatAttachment(file);
                    document.getElementById("chat-attachment-name").textContent = chatAttachment.name;
                    document.getElementById("chat-clear-attachment").hidden = false;
                    document.getElementById("chat-connection-status").textContent = "";
                } catch (error) {
                    clearChatAttachment();
                    document.getElementById("chat-connection-status").textContent = error.message;
                }
            });
            document.getElementById("chat-clear-attachment").addEventListener("click", clearChatAttachment);
            document.querySelector(".chat-emoji-list").addEventListener("click", event => {
                const button = event.target.closest("[data-chat-emoji]");
                if (!button) return;
                const input = document.getElementById("chat-message-input");
                const start = input.selectionStart;
                const end = input.selectionEnd;
                input.setRangeText(button.dataset.chatEmoji, start, end, "end");
                input.focus();
            });
            document.getElementById("chat-load-older").addEventListener("click", () => {
                if (chatMessages.length) void loadChatMessages(chatMessages[0].createdAt);
            });
            document.getElementById("paa-sync-pending").addEventListener("click", syncPendingPaaRecords);
            autocompleteSubmit.addEventListener("click", completeHistoryAutocomplete);
            autocompleteCancel.addEventListener("click", () => closeHistoryAutocomplete());
            autocompleteOverlay.addEventListener("click", event => {
                if (event.target === autocompleteOverlay) closeHistoryAutocomplete();
            });
            autocompleteOverlay.addEventListener("keydown", event => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    closeHistoryAutocomplete();
                    return;
                }
                if (event.key !== "Tab") return;
                const dialog = autocompleteOverlay.querySelector(".history-autocomplete");
                const focusable = [...dialog.querySelectorAll("input:not(:disabled), button:not(:disabled)")];
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            });
            const secretAdminTrigger = document.getElementById("secret-admin-trigger");
            document.getElementById("assistant-admin-open").addEventListener("click", () => {
                closeSettingsScreen(false);
                openAssistantAdmin();
            });
            let adminClickCount = 0;
            let lastAdminClick = 0;
            secretAdminTrigger.addEventListener("click", () => {
                const now = Date.now();
                adminClickCount = now - lastAdminClick > 2000 ? 1 : adminClickCount + 1;
                lastAdminClick = now;
                if (adminClickCount >= 5) {
                    adminClickCount = 0;
                    openAssistantAdmin();
                }
            });
            secretAdminTrigger.addEventListener("keydown", event => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openAssistantAdmin();
                }
            });
            document.addEventListener("keydown", event => {
                if (event.ctrlKey && event.shiftKey && event.key.toLocaleLowerCase("pt-BR") === "a") {
                    event.preventDefault();
                    openAssistantAdmin();
                }
            });
            setupAssistantAdmin();
            document.addEventListener("click", event => {
                if (event.target.closest("#tutorial-card")) return;
                if (!event.target.closest(".field-personal-autocomplete")) closeHistorySuggestions();
                if (!event.target.closest(".export-dock") && !exportMenu.hidden) {
                    exportMenu.hidden = true;
                    exportToggle.setAttribute("aria-expanded", "false");
                }
                const accessibilityMenu = document.getElementById("accessibility-menu");
                if (!event.target.closest(".accessibility-wrap") && !accessibilityMenu.hidden) {
                    closeSettingsScreen(false);
                }
            });

            const tutorialSteps = [
                { selector: "#form-title", title: "Comece por aqui", description: "Este formulário registra os atendimentos. Preencha os dados da pessoa e as informações do atendimento; os campos com * são obrigatórios." },
                { selector: "#nome", title: "Informe nome e CPF", description: "Digite o nome sem números e o CPF com seus 11 dígitos. A pontuação do CPF é preenchida automaticamente. Os dois campos são obrigatórios." },
                { selector: "#telefone", title: "Adicione um telefone", description: "O telefone é opcional. Se informar, digite os números incluindo o DDD." },
                { selector: "#endereco", title: "Registre o endereço", description: "O endereço também é opcional. Se preenchê-lo, o número do imóvel passa a ser obrigatório; use “s/n” se não houver número." },
                { selector: "#nationality-trigger", title: "Informe a nacionalidade", description: "A nacionalidade é opcional. Escolha uma opção, selecione “Não informada” ou adicione outra nacionalidade no topo da lista. Pesquise pelo campo ou clique na lista e digite; acentos, espaços e pontuação são ignorados." },
                { selector: "#date-disclosure summary", title: "Informe quando aconteceu", description: "Normalmente, o registro usa a data e a hora atuais. Para registrar um atendimento feito no papel, abra esta opção e informe quando ele ocorreu." },
                { selector: "#route-trigger", title: "Escolha o encaminhamento", description: "Abra as opções e selecione o encaminhamento adequado. Pesquise pelo campo ou clique na lista e digite; acentos, espaços e pontuação são ignorados. Para “Atendimento Técnico”, também é necessário selecionar o técnico responsável." },
                { selector: "#add-route-form", title: "Cadastre outro encaminhamento", description: "Se a opção desejada não estiver na lista, digite o nome e clique em Adicionar. No pop-up, escolha as filas associadas: 1 para Atendimento Técnico, 2 para Cadastro Único, ambas podem ser combinadas, e 3 para Nenhum." },
                { selector: "#assistant-choices", title: "Selecione o técnico", description: "Escolha quem realizou o atendimento. Clique novamente na pessoa selecionada para desmarcá-la. A seleção é obrigatória para o encaminhamento “Atendimento Técnico” e opcional nos demais." },
                { selector: "#appointment-form button[type='submit']", title: "Salve o registro", description: "Confira os dados e clique em Registrar atendimento. O registro fica salvo neste navegador e aparece no histórico." },
                { selector: "#dashboard-title", title: "Acompanhe os atendimentos do dia", description: "Este painel mostra somente o total de hoje e a quantidade por técnico. Atendimentos registrados com datas anteriores não entram nessa contagem." },
                { selector: ".queue-dashboards", title: "Controle as filas", description: "No Cadastro Único, as cadastradoras recebem um aviso após 25 minutos. No Atendimento Técnico, somente a pessoa responsável recebe um aviso após 15 minutos; o atendimento encerra automaticamente 10 minutos após ser iniciado. A recepção não recebe esses avisos. Se estiver preenchendo o formulário, o aviso aguarda 2 minutos sem atividade." },
                { selector: ".filter-panel", title: "Encontre um registro", description: "No histórico, filtre por data, nome, endereço, CPF, telefone, técnico ou encaminhamento. Você pode combinar vários filtros." },
                { selector: "#clear-filters", title: "Limpe os filtros", description: "Clique em Limpar filtros para remover todos os critérios e voltar a ver o histórico completo." },
                { selector: "#report-menu summary", title: "Monte uma tabela por período", description: "Escolha as datas inicial e final, filtre por técnico se desejar e marque as colunas que quer incluir. Exporte a tabela em .ods ou clique novamente neste título para recolhê-la." },
                { selector: "#export-toggle", title: "Abra Exportação", description: "Clique em Exportação para acessar as opções de planilha e de backup do histórico." },
                { selector: "#spreadsheet-export-title", title: "Exporte para planilha", description: "Exporte o último dia com registros, escolha uma data ou mês específico, ou exporte todos os atendimentos. O arquivo pode ser aberto no Excel." },
                { selector: "#json-export-title", title: "Exporte ou importe o histórico", description: "Exporte um backup JSON para guardar uma cópia do histórico, das pessoas e seus IDs, das anotações, dos técnicos, dos encaminhamentos e das preferências. Ao importar, novos registros e cadastros são mesclados; o que já está salvo e suas preferências são preservados." },
                { selector: "#accessibility-toggle", title: "Ajuste a acessibilidade", description: "Abra este menu para alternar entre os modos claro e escuro, aumentar a fonte, ocultar os textos explicativos ou ativar o preenchimento automático dos dados do histórico." }
            ];
            const tutorialCard = document.getElementById("tutorial-card");
            const tutorialOverlay = document.getElementById("tutorial-overlay");
            let tutorialIndex = 0;
            let tutorialTarget = null;

            function closeTutorial() {
                if (tutorialTarget) tutorialTarget.classList.remove("tutorial-target");
                tutorialTarget = null;
                document.getElementById("accessibility-menu").hidden = true;
                document.getElementById("accessibility-toggle").setAttribute("aria-expanded", "false");
                document.getElementById("export-menu").hidden = true;
                document.getElementById("export-toggle").setAttribute("aria-expanded", "false");
                document.getElementById("route-options").hidden = true;
                document.getElementById("route-trigger").setAttribute("aria-expanded", "false");
                document.getElementById("nationality-options").hidden = true;
                document.getElementById("nationality-trigger").setAttribute("aria-expanded", "false");
                tutorialCard.hidden = true;
                tutorialOverlay.hidden = true;
                document.getElementById("tutorial-start").focus();
            }

            function showTutorialStep(index) {
                if (tutorialTarget) tutorialTarget.classList.remove("tutorial-target");
                tutorialIndex = index;
                const step = tutorialSteps[tutorialIndex];
                const needsAccessibilityMenu = step.selector === "#accessibility-toggle";
                const needsExportMenu = step.selector === "#spreadsheet-export-title" || step.selector === "#json-export-title";
                const needsRouteOptions = step.selector === "#add-route-form";
                const needsNationalityOptions = step.selector === "#nationality-trigger";
                const needsReportMenu = step.selector === "#report-menu summary";
                const accessibilityMenu = document.getElementById("accessibility-menu");
                const exportMenu = document.getElementById("export-menu");
                const routeOptions = document.getElementById("route-options");
                const nationalityOptions = document.getElementById("nationality-options");
                document.getElementById("report-menu").open = needsReportMenu;
                accessibilityMenu.hidden = !needsAccessibilityMenu;
                document.getElementById("accessibility-toggle").setAttribute("aria-expanded", String(needsAccessibilityMenu));
                exportMenu.hidden = !needsExportMenu;
                document.getElementById("export-toggle").setAttribute("aria-expanded", String(needsExportMenu));
                routeOptions.hidden = !needsRouteOptions;
                document.getElementById("route-trigger").setAttribute("aria-expanded", String(needsRouteOptions));
                nationalityOptions.hidden = !needsNationalityOptions;
                document.getElementById("nationality-trigger").setAttribute("aria-expanded", String(needsNationalityOptions));
                tutorialTarget = document.querySelector(step.selector);
                tutorialTarget.classList.add("tutorial-target");
                tutorialTarget.scrollIntoView({ behavior: "smooth", block: "center" });
                document.getElementById("tutorial-step").textContent = `Passo ${tutorialIndex + 1} de ${tutorialSteps.length}`;
                document.getElementById("tutorial-title").textContent = step.title;
                document.getElementById("tutorial-description").textContent = step.description;
                document.getElementById("tutorial-count").textContent = `${tutorialIndex + 1}/${tutorialSteps.length}`;
                document.getElementById("tutorial-previous").disabled = tutorialIndex === 0;
                document.getElementById("tutorial-next").textContent = tutorialIndex === tutorialSteps.length - 1 ? "Concluir" : "Próximo";
                tutorialCard.hidden = false;
                tutorialOverlay.hidden = false;
                document.getElementById("tutorial-next").focus();
            }

            document.getElementById("tutorial-start").addEventListener("click", () => showTutorialStep(0));
            document.getElementById("tutorial-close").addEventListener("click", closeTutorial);
            document.getElementById("tutorial-previous").addEventListener("click", () => {
                if (tutorialIndex > 0) showTutorialStep(tutorialIndex - 1);
            });
            document.getElementById("tutorial-next").addEventListener("click", () => {
                if (tutorialIndex === tutorialSteps.length - 1) closeTutorial();
                else showTutorialStep(tutorialIndex + 1);
            });
            document.addEventListener("keydown", event => {
                if (event.key === "Escape" && !tutorialCard.hidden) closeTutorial();
            });

            const dropOverlay = document.getElementById("drop-overlay");
            let dragDepth = 0;
            document.addEventListener("dragenter", event => {
                if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return;
                event.preventDefault();
                dragDepth += 1;
                dropOverlay.hidden = false;
            });
            document.addEventListener("dragover", event => {
                if (event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
            });
            document.addEventListener("dragleave", event => {
                if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return;
                dragDepth = Math.max(0, dragDepth - 1);
                if (dragDepth === 0) dropOverlay.hidden = true;
            });
            document.addEventListener("drop", event => {
                if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return;
                event.preventDefault();
                dragDepth = 0;
                dropOverlay.hidden = true;
                const file = event.dataTransfer.files[0];
                if (!file) return;
                if (!file.name.toLocaleLowerCase("pt-BR").endsWith(".json")) {
                    showToast("Selecione um arquivo de backup JSON.");
                    return;
                }
                importBackup(file);
            });

            appointmentDateInput.addEventListener("input", () => { appointmentDateEdited = true; });
            appointmentDateInput.addEventListener("change", () => { appointmentDateEdited = true; });
            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "visible") {
                    refreshCurrentDay().then(async () => {
                        await ensureQueueTimestamps();
                        scheduleDayRefresh();
                        await processQueueTimers();
                        scheduleSyncAfterActivation();
                    });
                }
            });
            window.addEventListener("focus", () => refreshCurrentDay().then(async () => {
                await ensureQueueTimestamps();
                scheduleDayRefresh();
                await processQueueTimers();
                scheduleSyncAfterActivation();
            }));
            appointmentDateInput.value = currentLocalDateTime();
            applyPreferences();
            await setupAccessGate();
            await restoreLocalUser();
            if (mobilePendingSync && !mobileOfflineMode) {
                scheduleLocalSnapshotPersist(activeUser?.role);
            }
            completeBootScreen();
            await refreshCurrentDay();
            await ensureQueueTimestamps();
            scheduleDayRefresh();
            setupModuleTabs();
            setupGoogleSync();
            renderAssistants();
            renderRoutes();
            renderNationalities();
            addressInput.dispatchEvent(new Event("input"));
            renderAll();
            startChatServices();

            window.copyFieldValue = function(elementId, label) {
                const input = document.getElementById(elementId);
                if (!input || !input.value) return;
                const value = input.value;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(value).then(() => {
                        showToast(`${label || 'Valor'} copiado!`);
                    }).catch(() => {
                        input.select();
                        document.execCommand('copy');
                        showToast(`${label || 'Valor'} copiado!`);
                    });
                } else {
                    input.select();
                    document.execCommand('copy');
                    showToast(`${label || 'Valor'} copiado!`);
                }
            };

            const checkUpdatesBtn = document.getElementById("check-updates-btn");
            if (checkUpdatesBtn) {
                checkUpdatesBtn.addEventListener("click", async () => {
                    const statusBadge = document.getElementById("update-status-badge");
                    const actionArea = document.getElementById("update-action-area");
                    checkUpdatesBtn.disabled = true;
                    statusBadge.hidden = false;
                    statusBadge.className = "update-badge update-badge-checking";
                    statusBadge.textContent = "Consultando atualizações no GitHub…";
                    if (actionArea) actionArea.hidden = true;

                    try {
                        const res = await fetch("/api/check-update", { cache: "no-store" });
                        if (!res.ok) throw new Error("Não foi possível conectar ao verificador.");
                        const data = await res.json();
                        const versionBadge = document.getElementById("current-app-version-badge");
                        if (versionBadge && data.currentVersion) {
                            versionBadge.textContent = `v${data.currentVersion}`;
                        }

                        if (data.hasUpdate) {
                            statusBadge.className = "update-badge update-badge-available";
                            statusBadge.textContent = `Nova versão ${data.latestVersion} disponível!`;
                            if (actionArea) {
                                actionArea.hidden = false;
                                actionArea.innerHTML = `
                                    <button class="button-primary" id="btn-run-update" type="button" style="width: 100%; margin-top: 8px;">
                                        ⬇️ Baixar e Instalar v${data.latestVersion}
                                    </button>
                                `;
                                document.getElementById("btn-run-update").onclick = async () => {
                                    if (!window.confirm(`Deseja baixar e instalar a versão ${data.latestVersion}? O aplicativo será reiniciado.`)) return;
                                    statusBadge.textContent = "Baixando atualização… Aguarde alguns segundos.";
                                    try {
                                        const postRes = await fetch("/api/apply-update", { method: "POST", cache: "no-store" });
                                        const postData = await postRes.json();
                                        if (!postRes.ok) throw new Error(postData.error || "Erro ao aplicar.");
                                        statusBadge.textContent = postData.message || "Atualização concluída. Reiniciando…";
                                    } catch (err) {
                                        statusBadge.className = "update-badge update-badge-error";
                                        statusBadge.textContent = `Erro: ${err.message}`;
                                    }
                                };
                            }
                        } else {
                            statusBadge.className = "update-badge update-badge-latest";
                            statusBadge.textContent = `Você está na versão mais recente (${data.currentVersion ? 'v' + data.currentVersion : 'atualizada'}).`;
                        }
                    } catch (err) {
                        statusBadge.className = "update-badge update-badge-error";
                        statusBadge.textContent = `Não foi possível verificar: ${err.message}`;
                    } finally {
                        checkUpdatesBtn.disabled = false;
                    }
                });
            }

            await processQueueTimers();
            window.setInterval(processQueueTimers, 30_000);
            window.setInterval(renderQueues, 30_000);
            if (window.CRASDesktop) {
                scheduleLocalSnapshotPersist();
                window.setInterval(() => {
                    if (document.visibilityState === "visible") void refreshLocalNodeFromServer();
                }, 5000);
            } else if (mobileClient) {
                window.setInterval(() => void refreshMobileSnapshotFromServer(), 5000);
            }
        })();
