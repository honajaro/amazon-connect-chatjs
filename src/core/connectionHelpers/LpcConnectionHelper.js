import { EventBus } from "../eventbus";
import { LogManager } from "../../log";
import {
    ConnectionHelperEvents,
    ConnectionHelperStatus
} from "./baseConnectionHelper";
import BaseConnectionHelper from "./baseConnectionHelper";
import WebSocketManager from "../../lib/amazon-connect-websocket-manager";
import { CSM_CATEGORY, TRANSPORT_LIFETIME_IN_SECONDS, WEBSOCKET_EVENTS } from "../../constants";
import { csmService } from "../../service/csmService";

class LpcConnectionHelper extends BaseConnectionHelper {

    constructor(contactId, initialContactId, connectionDetailsProvider, websocketManager, logMetaData) {
        super(connectionDetailsProvider, logMetaData);

        // WebsocketManager instance is only provided iff agent connections
        this.customerConnection = !websocketManager;

        if (this.customerConnection) {
            // ensure customer base instance exists for this contact ID
            if (!LpcConnectionHelper.customerBaseInstances[contactId]) {
                LpcConnectionHelper.customerBaseInstances[contactId] =
          new LpcConnectionHelperBase(connectionDetailsProvider, undefined, logMetaData);
            }
            this.baseInstance = LpcConnectionHelper.customerBaseInstances[contactId];
        } else {
            // cleanup agent base instance if it exists for old websocket manager
            if (LpcConnectionHelper.agentBaseInstance) {
                if (LpcConnectionHelper.agentBaseInstance.getWebsocketManager() !== websocketManager) {
                    LpcConnectionHelper.agentBaseInstance.end();
                    LpcConnectionHelper.agentBaseInstance = null;
                }
            }
            // ensure agent base instance exists
            if (!LpcConnectionHelper.agentBaseInstance) {
                LpcConnectionHelper.agentBaseInstance =
          new LpcConnectionHelperBase(undefined, websocketManager, logMetaData);
            }
            this.baseInstance = LpcConnectionHelper.agentBaseInstance;
        }

        this.contactId = contactId;
        this.initialContactId = initialContactId;
        this.status = null;
        this.eventBus = new EventBus();
        this.subscriptions = [
            this.baseInstance.onEnded(this.handleEnded.bind(this)),
            this.baseInstance.onConnectionGain(this.handleConnectionGain.bind(this)),
            this.baseInstance.onConnectionLost(this.handleConnectionLost.bind(this)),
            this.baseInstance.onMessage(this.handleMessage.bind(this))
        ];
    }

    start() {
        super.start();
        return this.baseInstance.start();
    }

    end() {
        super.end();
        this.eventBus.unsubscribeAll();
        this.subscriptions.forEach(unsubscribe => unsubscribe());
        this.status = ConnectionHelperStatus.Ended;
        this.tryCleanup();
    }

    tryCleanup() {
        if (this.customerConnection && !this.baseInstance.hasMessageSubscribers()) {
            this.baseInstance.end();
            delete LpcConnectionHelper.customerBaseInstances[this.contactId];
        }
    }

    getStatus() {
        return this.status || this.baseInstance.getStatus();
    }

    onEnded(handler) {
        return this.eventBus.subscribe(ConnectionHelperEvents.Ended, handler);
    }

    handleEnded() {
        this.eventBus.trigger(ConnectionHelperEvents.Ended, {});
    }

    onConnectionGain(handler) {
        return this.eventBus.subscribe(ConnectionHelperEvents.ConnectionGained, handler);
    }

    handleConnectionGain() {
        this.eventBus.trigger(ConnectionHelperEvents.ConnectionGained, {});
    }

    onConnectionLost(handler) {
        return this.eventBus.subscribe(ConnectionHelperEvents.ConnectionLost, handler);
    }

    handleConnectionLost() {
        this.eventBus.trigger(ConnectionHelperEvents.ConnectionLost, {});
    }

    onMessage(handler) {
        return this.eventBus.subscribe(ConnectionHelperEvents.IncomingMessage, handler);
    }

    handleMessage(message) {
        if (message.InitialContactId === this.initialContactId || message.ContactId === this.contactId) {
            this.eventBus.trigger(ConnectionHelperEvents.IncomingMessage, message);
        }
    }
}
LpcConnectionHelper.customerBaseInstances = {};
LpcConnectionHelper.agentBaseInstance = null;


class LpcConnectionHelperBase {
    constructor(connectionDetailsProvider, websocketManager, logMetaData) {
        this.status = ConnectionHelperStatus.NeverStarted;
        this.eventBus = new EventBus();
        window.LpcConnectionHelperBase = {
            eventBus: this.eventBus
        };
        this.logger = LogManager.getLogger({
            prefix: "ChatJS-LPCConnectionHelperBase",
            logMetaData
        });
        this.initWebsocketManager(websocketManager, connectionDetailsProvider, logMetaData);
    }

    initWebsocketManager(websocketManager, connectionDetailsProvider, logMetaData) {
        this.websocketManager = websocketManager || WebSocketManager.create(logMetaData);
        this.websocketManager.subscribeTopics(["aws/chat"]);
        this.subscriptions = [
            this.websocketManager.onMessage("aws/chat", this.handleMessage.bind(this)),
            this.websocketManager.onConnectionGain(this.handleConnectionGain.bind(this)),
            this.websocketManager.onConnectionLost(this.handleConnectionLost.bind(this)),
            this.websocketManager.onInitFailure(this.handleEnded.bind(this))
        ];
        this.logger.info("Initializing websocket manager.");
        if (!websocketManager) {
            const startTime = new Date().getTime();
            this.websocketManager.init(
                () => connectionDetailsProvider.fetchConnectionDetails()
                    .then(connectionDetails => {
                        const details = {
                            webSocketTransport: {
                                url: connectionDetails.url,
                                expiry: connectionDetails.expiry,
                                transportLifeTimeInSeconds: TRANSPORT_LIFETIME_IN_SECONDS
                            }
                        };
                        const logContent = { expiry: connectionDetails.expiry, transportLifeTimeInSeconds: TRANSPORT_LIFETIME_IN_SECONDS };
                        this.logger.debug("Websocket manager initialized. Connection details:", logContent);
                        csmService.addLatencyMetricWithStartTime(WEBSOCKET_EVENTS.InitWebsocket, startTime, CSM_CATEGORY.API);
                        csmService.addCountAndErrorMetric(WEBSOCKET_EVENTS.InitWebsocket, CSM_CATEGORY.API, false);
                        return details;
                    }
                    ).catch(error => {
                        this.logger.error("Initializing Websocket Manager failed:", error);
                        csmService.addLatencyMetricWithStartTime(WEBSOCKET_EVENTS.InitWebsocket, startTime, CSM_CATEGORY.API);
                        csmService.addCountAndErrorMetric(WEBSOCKET_EVENTS.InitWebsocket, CSM_CATEGORY.API, true);
                        throw error;
                    })
            );
        }
    }

    end() {
    // WebSocketProvider instance from streams does not have closeWebSocket
        if (this.websocketManager.closeWebSocket) {
            this.websocketManager.closeWebSocket();
        }
        this.eventBus.unsubscribeAll();
        this.subscriptions.forEach(unsubscribe => unsubscribe());
        this.logger.info("Websocket closed. All event subscriptions are cleared.");
    }

    start() {
        if (this.status === ConnectionHelperStatus.NeverStarted) {
            this.status = ConnectionHelperStatus.Starting;
        }
        return Promise.resolve();
    }

    onEnded(handler) {
        return this.eventBus.subscribe(ConnectionHelperEvents.Ended, handler);
    }

    handleEnded() {
        this.status = ConnectionHelperStatus.Ended;
        this.eventBus.trigger(ConnectionHelperEvents.Ended, {});
        this.logger.info("Websocket connection ended.");
        csmService.addCountMetric(WEBSOCKET_EVENTS.Ended, CSM_CATEGORY.API);
    }

    onConnectionGain(handler) {
        return this.eventBus.subscribe(ConnectionHelperEvents.ConnectionGained, handler);
    }

    handleConnectionGain() {
        this.status = ConnectionHelperStatus.Connected;
        this.eventBus.trigger(ConnectionHelperEvents.ConnectionGained, {});
        this.logger.info("Websocket connection gained.");
        csmService.addCountMetric(WEBSOCKET_EVENTS.ConnectionGained, CSM_CATEGORY.API);
    }

    onConnectionLost(handler) {
        return this.eventBus.subscribe(ConnectionHelperEvents.ConnectionLost, handler);
    }

    handleConnectionLost() {
        this.status = ConnectionHelperStatus.ConnectionLost;
        this.eventBus.trigger(ConnectionHelperEvents.ConnectionLost, {});
        this.logger.info("Websocket connection lost.");
        csmService.addCountMetric(WEBSOCKET_EVENTS.ConnectionLost, CSM_CATEGORY.API);
    }

    onMessage(handler) {
        return this.eventBus.subscribe(ConnectionHelperEvents.IncomingMessage, handler);
    }

    handleMessage(message) {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message.content);
            this.eventBus.trigger(ConnectionHelperEvents.IncomingMessage, parsedMessage);
            this.logger.info("this.eventBus trigger Websocket incoming message", ConnectionHelperEvents.IncomingMessage, parsedMessage);
            csmService.addCountMetric(WEBSOCKET_EVENTS.IncomingMessage, CSM_CATEGORY.API);
        } catch (e) {
            this._sendInternalLogToServer(this.logger.error("Wrong message format"));
        }
    }

    getStatus() {
        return this.status;
    }

    getWebsocketManager() {
        return this.websocketManager;
    }

    hasMessageSubscribers() {
        return this.eventBus.getSubscriptions(ConnectionHelperEvents.IncomingMessage).length > 0;
    }

    _sendInternalLogToServer(logEntry) {
        if (logEntry && typeof logEntry.sendInternalLogToServer === "function")
            logEntry.sendInternalLogToServer();

        return logEntry;
    }
}

export default LpcConnectionHelper;
