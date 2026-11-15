(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);
    const info = { model: "", serial: "", firmware: "" };
    let connected = false;
    let usbClient = null;
    let requestChain = Promise.resolve();
    let statusReadFailed = false;

    function notice(message, kind = "") {
        const element = $("notice");
        if (!element) return;
        element.textContent = message;
        element.className = kind;
    }

    function setConnectionStatus(message) {
        $("connection-state").textContent = message;
    }

    function isUsbConnection() {
        return $("connection-type").value === "usb";
    }

    function setCommandField(id, value) {
        const field = $(id);
        if (field) field.textContent = value;
    }

    function baseUrl() {
        const address = $("address").value.trim();
        const port = Number($("port").value);
        if (!/^[a-z0-9.-]+$/i.test(address)) throw new Error("Enter a hostname or IPv4 address.");
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("HTTP port must be 1-65535.");
        return `http://${address}:${port}`;
    }

    function queued(operation) {
        const result = requestChain.then(operation, operation);
        requestChain = result.catch(() => {});
        return result;
    }

    async function send(command) {
        if (!/^[\x20-\x7e]{1,63}$/.test(command)) throw new Error("Command must be 1-63 printable ASCII characters.");
        return queued(async () => {
            const time = () => new Date().toLocaleTimeString();
            setCommandField("last-command", `${command} (${time()})`);
            if (isUsbConnection()) {
                if (!usbClient) throw new Error("Connect to a Mini-Circuits switch over USB first.");
                try {
                    const text = await usbClient.send(command);
                    setCommandField("last-response", `${text || "empty response"} (${time()})`);
                    return text;
                } catch (error) {
                    setCommandField("last-response", `${error.message} (${time()})`);
                    throw error;
                }
            }
            const password = $("password").value;
            const request = password ? `${password};${command}` : command;
            // The switch firmware treats a trailing query marker as an HTTP query.
            // Keep it after the slash rather than encoding it into the path.
            const url = command.endsWith("?")
                ? `${baseUrl()}/?${encodeURI(request)}`
                : `${baseUrl()}/${encodeURI(request)}`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            try {
                const response = await fetch(url, { cache: "no-store", signal: controller.signal });
                const text = (await response.text()).trim();
                setCommandField("last-response", `${text || "empty response"} (${time()})`);
                if (!response.ok) {
                    const error = new Error(`HTTP ${response.status}: ${text || "empty response"}`);
                    error.connectionFailure = true;
                    throw error;
                }
                if (text.startsWith("-")) throw new Error(`Device rejected ${command}: ${text}`);
                return text;
            } catch (error) {
                if (error.name === "AbortError") {
                    error.connectionFailure = true;
                    error.message = "HTTP request timed out after 5 seconds.";
                } else if (error.name === "TypeError") error.connectionFailure = true;
                setCommandField("last-response", `${error.message} (${time()})`);
                throw error;
            } finally {
                clearTimeout(timeout);
            }
        });
    }

    function switchCount() {
        return Number($("switch-count").value);
    }

    function portCount() {
        return Number($("port-count").value);
    }

    function modelType() {
        const ports = portCount();
        return ports === 8 ? "SP8T" : ports === 6 ? "SP6T" : ports === 4 ? "SP4T" : "SPDT";
    }

    function switchName(index) {
        return String.fromCharCode(65 + index);
    }

    function renderControls(states = []) {
        const type = modelType();
        const count = switchCount();
        const maxState = type === "SPDT" ? 1 : portCount();
        const container = $("switch-controls");
        const table = document.createElement("table");
        const body = document.createElement("tbody");
        for (let index = 0; index < count; index += 1) {
            const row = document.createElement("tr");
            const title = document.createElement("th");
            title.scope = "row";
            title.style.textAlign = "left";
            title.textContent = `Switch ${switchName(index)}`;
            const state = document.createElement("div");
            state.className = "state";
            state.id = `state-${index}`;
            state.textContent = states[index] === undefined ? "Not read" : `Current state: ${states[index]}`;
            const select = document.createElement("select");
            select.id = `select-${index}`;
            for (let value = 0; value <= maxState; value += 1) {
                const option = document.createElement("option");
                option.value = String(value);
                option.textContent = type === "SPDT" ? (value ? "Port 2" : "Port 1") : (value ? `Port ${value}` : "Disconnected");
                select.append(option);
            }
            if (states[index] !== undefined && states[index] <= maxState) select.value = String(states[index]);
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "Set";
            button.addEventListener("click", () => setSingle(index, Number(select.value)));
            const controls = document.createElement("td");
            controls.append(state, document.createTextNode(" "), select, document.createTextNode(" "), button);
            row.append(title, controls);
            body.append(row);
        }
        table.append(body);
        container.replaceChildren(table);
    }

    function parseSingleState(text) {
        const match = text.match(/(?:^|[\s=])([0-9]+)\s*$/);
        return match ? Number(match[1]) : null;
    }

    async function readStatus() {
        const type = modelType();
        const count = switchCount();
        const states = [];
        if (type === "SPDT") {
            const encoded = parseSingleState(await send("SWPORT?"));
            if (encoded === null) throw new Error("Could not parse SWPORT response.");
            for (let i = 0; i < count; i += 1) states.push((encoded >> i) & 1);
        } else {
            for (let i = 0; i < count; i += 1) {
                const value = parseSingleState(await send(`${type}${switchName(i)}:STATE?`));
                if (value === null) throw new Error(`Could not parse switch ${switchName(i)} state.`);
                states.push(value);
            }
        }
        renderControls(states);
        return states;
    }

    async function identify(autofill = false) {
        const responses = await Promise.all(["MN?", "SN?", "FIRMWARE?"].map((command) => send(command)));
        info.model = (responses[0].match(/MN[:=]\s*([^\s]+)/i) || [])[1] || responses[0];
        info.serial = (responses[1].match(/SN[:=]\s*([^\s]+)/i) || [])[1] || responses[1];
        info.firmware = responses[2];
        connected = true;
        setConnectionStatus(`${info.model} (${new Date().toLocaleTimeString()})`);
        if (autofill) fillConfigurationFromModel();
        if (switchCount() && portCount()) await readStatus();
        await readFullStatus();
        setConnectionStatus(statusReadFailed ? "Failed" : `${info.model} (${new Date().toLocaleTimeString()})`);
    }

    async function readFullStatus() {
        statusReadFailed = false;
        const rows = [
            ["Model", () => send("MN?")],
            ["Serial number", () => send("SN?")],
            ["Firmware", () => send("FIRMWARE?")],
            ["Temperature sensor 1", () => send("TEMP1?")],
            ["Temperature sensor 2", () => send("TEMP2?")],
            ["Temperature sensor 3", () => send("TEMP3?")],
            ["Heat alarm", () => send("HEATALARM?")],
            ["Fan status", () => send("FAN?")],
            ["Active Ethernet configuration", () => send(":ETHERNET:CONFIG:LISTEN?")],
            ["MAC address", () => send(":ETHERNET:CONFIG:MAC?")],
            ["DHCP enabled", () => send(":ETHERNET:CONFIG:DHCPENABLED?")],
            ["Static IP address", () => send(":ETHERNET:CONFIG:IP?")],
            ["Static subnet mask", () => send(":ETHERNET:CONFIG:SM?")],
            ["Static gateway", () => send(":ETHERNET:CONFIG:NG?")],
            ["HTTP port", () => send(":ETHERNET:CONFIG:HTPORT?")],
            ["Telnet port", () => send(":ETHERNET:CONFIG:TELNETPORT?")],
            ["SSH port", () => send(":ETHERNET:CONFIG:SSHPORT?")],
            ["SSH login name", () => send(":ETHERNET:CONFIG:SSHLOGINNAME?")],
            ["Password enabled", () => send(":ETHERNET:CONFIG:PWDENABLED?")],
            ["Power-up last state", () => send("ONPOWERUP:LASTSTATE?")]
        ];
        if (isUsbConnection()) {
            const ethernetRows = new Set([
                "Active Ethernet configuration", "MAC address", "DHCP enabled", "Static IP address",
                "Static subnet mask", "Static gateway", "HTTP port", "Telnet port", "SSH port",
                "SSH login name", "Password enabled"
            ]);
            for (let index = rows.length - 1; index >= 0; index -= 1) {
                if (ethernetRows.has(rows[index][0])) rows.splice(index, 1);
            }
        }
        if (switchCount() && portCount()) {
            const type = modelType();
            for (let index = 0; index < switchCount(); index += 1) {
                rows.push([`Switch ${switchName(index)} state`, () => type === "SPDT"
                    ? send("SWPORT?").then((value) => `${(parseSingleState(value) >> index) & 1}`)
                    : send(`${type}${switchName(index)}:STATE?`)]);
                rows.push([`Switch ${switchName(index)} counters`, () => type === "SPDT"
                    ? send(`SC${switchName(index)}?`)
                    : send(`${type}${switchName(index)}:COUNTERS?`)]);
            }
        }
        const statusRows = [];
        for (const [label, query] of rows) {
            try { statusRows.push([label, await query()]); }
            catch (error) {
                if (error.connectionFailure) statusReadFailed = true;
                statusRows.push([label, error.message]);
            }
        }
        $("status-body").replaceChildren(...statusRows.map(([label, value]) => {
            const row = document.createElement("tr");
            const name = document.createElement("td");
            const result = document.createElement("td");
            name.textContent = label;
            result.textContent = value;
            row.append(name, result);
            return row;
        }));
        $("status-updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
    }

    function configurationFromModel(model) {
        const match = model.match(/(?:RC-|USB-|ZTRC-)(\d+)(SPDT|SP4T|SP6T|SP8T)/i);
        if (!match) throw new Error(`Could not determine switch configuration from model ${model}.`);
        const type = match[2].toUpperCase();
        return {
            switchCount: Number(match[1]),
            portCount: type === "SPDT" ? 2 : type === "SP4T" ? 4 : type === "SP6T" ? 6 : 8
        };
    }

    function modelNameFromResponse(response) {
        const text = response.trim();
        const match = text.match(/^MN[:=]\s*(.+)$/i);
        return (match ? match[1] : text).trim();
    }

    function fillConfigurationFromModel() {
        const configuration = configurationFromModel(info.model);
        $("switch-count").value = String(configuration.switchCount);
        $("port-count").value = String(configuration.portCount);
        renderControls();
    }

    async function setSingle(index, state) {
        const type = modelType();
        const name = switchName(index);
        const command = type === "SPDT" ? `SET${name}=${state}` : `${type}${name}:STATE:${state}`;
        try {
            const response = await send(command);
            if (response !== "1") throw new Error(`Device returned ${response || "an empty response"}.`);
            notice(`Switch ${name} updated.`, "success");
            await readStatus();
        } catch (error) { notice(error.message, "error"); }
    }

    async function connectUsb() {
        if (!navigator.hid) {
            throw new Error("WebHID is unavailable. Use Chrome or Edge over HTTPS or localhost.");
        }
        const { VENDOR_ID, PRODUCT_ID, MiniCircuitsSwitchUSBClient } = window.MiniCircuitsSwitchUSB;
        const authorized = await navigator.hid.getDevices();
        const device = authorized.find((item) => item.vendorId === VENDOR_ID && item.productId === PRODUCT_ID)
            || (await navigator.hid.requestDevice({ filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }] }))[0];
        if (!device) throw new Error("No Mini-Circuits switch was selected.");
        const client = new MiniCircuitsSwitchUSBClient(device);
        try {
            await client.connect();
        } catch (error) {
            if (error.name === "NotAllowedError") {
                throw new Error("USB access was denied by the operating system. Allow access to the Mini-Circuits HID device and try again.");
            }
            throw error;
        }
        usbClient = client;
        try {
            const response = await send("MN?");
            connected = true;
            setConnectionStatus(`${response.replace(/^MN[=:]\s*/i, "")} (${new Date().toLocaleTimeString()})`);
            notice("", "");
        } catch (error) {
            await client.disconnect();
            usbClient = null;
            throw error;
        }
    }

    $("connection-type").addEventListener("change", async () => {
        const usb = isUsbConnection();
        $("ethernet-settings").hidden = usb;
        $("test-button").textContent = usb ? "Connect USB device" : "Test connection";
        let disconnectError = null;
        if (usbClient) {
            try { await usbClient.disconnect(); }
            catch (error) { disconnectError = error; }
            usbClient = null;
        }
        connected = false;
        setConnectionStatus(disconnectError ? `Failed: ${disconnectError.message}` : "Not connected");
        if (!usb) notice("");
    });

    $("test-button").addEventListener("click", async () => {
        $("test-button").disabled = true;
        try {
            if (isUsbConnection()) {
                if (usbClient) {
                    const response = await send("MN?");
                    connected = true;
                    setConnectionStatus(`${response.replace(/^MN[=:]\s*/i, "")} (${new Date().toLocaleTimeString()})`);
                } else {
                    await connectUsb();
                }
            } else {
                const response = await send("MN?");
                connected = true;
                setConnectionStatus(`${response.replace(/^MN[=:]\s*/i, "")} (${new Date().toLocaleTimeString()})`);
            }
        } catch (error) {
            if (error.connectionFailure) {
                connected = false;
                setConnectionStatus("Failed");
            } else setConnectionStatus(error.message);
            notice(error.message, "error");
        } finally { $("test-button").disabled = false; }
    });
    $("refresh-button").addEventListener("click", async () => {
        $("refresh-button").disabled = true;
        notice("Refreshing device status...");
        try { await identify(); notice(""); }
        catch (error) {
            if (error.connectionFailure) {
                connected = false;
                setConnectionStatus("Failed");
            }
            notice(error.message, "error");
        }
        finally { $("refresh-button").disabled = false; }
    });
    $("auto-identify-button").addEventListener("click", async () => {
        try {
            info.model = modelNameFromResponse(await send("MN?"));
            fillConfigurationFromModel();
            notice(`Detected ${info.model}.`, "success");
            if (connected) await readStatus();
        } catch (error) {
            if (error.connectionFailure) {
                connected = false;
                setConnectionStatus("Failed");
            } else setConnectionStatus(error.message);
            notice(error.message, "error");
        }
    });
    $("switch-count").addEventListener("change", () => { if (portCount()) renderControls(); });
    $("port-count").addEventListener("change", () => { if (switchCount()) renderControls(); });
    $("connection-type").dispatchEvent(new Event("change"));
    window.MiniCircuitsSwitch = {
        parseSingleState,
        modelType,
        switchName,
        configurationFromModel,
        modelNameFromResponse
    };
})();
