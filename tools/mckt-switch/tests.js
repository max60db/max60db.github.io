(function () {
    "use strict";

    const results = document.getElementById("results");
    const api = window.MiniCircuitsSwitch;
    let passed = 0;
    let failed = 0;

    function assert(condition, message) {
        if (!condition) throw new Error(message);
    }

    function test(name, action) {
        const row = document.createElement("li");
        try {
            action();
            row.textContent = `PASS ${name}`;
            passed += 1;
        } catch (error) {
            row.textContent = `FAIL ${name}: ${error.message}`;
            failed += 1;
        }
        results.append(row);
    }

    test("parses numeric switch responses", () => {
        assert(api.parseSingleState("1") === 1, "plain response failed");
        assert(api.parseSingleState("1=683 2=641 3=120") === 120, "counter response failed");
        assert(api.parseSingleState("-99 unknown command") === null, "error response accepted");
    });

    test("names switches alphabetically", () => {
        assert(api.switchName(0) === "A", "first switch name incorrect");
        assert(api.switchName(7) === "H", "eighth switch name incorrect");
    });

    test("selects the protocol family from ports per switch", () => {
        document.getElementById("port-count").value = "2";
        assert(api.modelType() === "SPDT", "SPDT selection failed");
        document.getElementById("port-count").value = "4";
        assert(api.modelType() === "SP4T", "SP4T selection failed");
        document.getElementById("port-count").value = "6";
        assert(api.modelType() === "SP6T", "SP6T selection failed");
    });

    document.getElementById("summary").textContent = `${passed} passed, ${failed} failed`;
})();
