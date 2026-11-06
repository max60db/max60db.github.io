(function () {
    "use strict";
    const results = document.getElementById("results");
    let passed = 0;
    let failed = 0;
    function test(name, action) {
        const row = document.createElement("li");
        try { action(); row.textContent = `PASS ${name}`; passed += 1; }
        catch (error) { row.textContent = `FAIL ${name}: ${error.message}`; failed += 1; }
        results.append(row);
    }
    test("trims measurement responses", () => {
        if (window.MiniCircuitsPower.parseResponse(" -12.50 dBm ") !== "-12.50 dBm") throw new Error("response was not trimmed");
    });
    test("does not treat a numeric negative reading as a command error", () => {
        if (window.MiniCircuitsPower.parseResponse("-99.000 dBm") !== "-99.000 dBm") throw new Error("numeric reading was rejected");
    });
    test("exposes the power-meter API", () => {
        if (!window.MiniCircuitsPower) throw new Error("API missing");
    });
    test("allows a blank address until connection is attempted", () => {
        if (document.getElementById("address").value !== "") throw new Error("address should be blank");
    });
    test("provides auto-refresh controls", () => {
        if (!document.getElementById("auto-refresh-button") || !document.getElementById("disable-auto-refresh-button")) {
            throw new Error("auto-refresh controls missing");
        }
    });
    test("starts with auto-refresh ready to enable", () => {
        if (document.getElementById("auto-refresh-button").disabled) throw new Error("auto-refresh start button should be enabled");
        if (document.getElementById("disable-auto-refresh-button").disabled) throw new Error("disable button should always be enabled");
    });
    test("provides compensation frequency controls", () => {
        if (!document.getElementById("compensation-frequency") || !document.getElementById("set-compensation-frequency-button")) {
            throw new Error("compensation frequency controls missing");
        }
    });
    test("keeps the complete status table available", () => {
        if (!document.getElementById("status-body")) throw new Error("status table missing");
    });
    document.getElementById("summary").textContent = `${passed} passed, ${failed} failed`;
})();
