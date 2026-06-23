// Panorama alignment workflow, downstream of MakeSimilars.bulkSimilars.
// Results are GROUPED BY SOURCE (like the `str` view): a source never repeats across rows.
// 1) split candidate pairs into exact (case + English plural) vs non-exact
// 2) render exact pairs in a checkbox jsTree grouped by source (parent = source, children = targets)
// 3) generate owl:equivalentClass triples for the validated (checked) pairs
// 4) display the remaining non-exact pairs grouped by source (input for the LLM step)
import { matchesCaseAndPlural } from "./matchUtils.js";

var AlignWorkflow = (function () {
    var self = {};

    var OWL_EQUIVALENT_CLASS = "http://www.w3.org/2002/07/owl#equivalentClass";
    var NODE_ID_SEPARATOR = " ||| ";

    self._pairByNodeId = {};
    self._validationDivId = null;

    /**
     * Escapes a string for safe HTML insertion.
     * @param {string} str - The raw string.
     * @returns {string} The escaped string.
     */
    function escapeHtml(str) {
        return String(str == null ? "" : str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    /**
     * Formats a numeric score with one decimal, or an empty string when absent.
     * @param {number} score - The ElasticSearch score.
     * @returns {string} The formatted score.
     */
    function formatScore(score) {
        if (score == null) {
            return "";
        }
        return Number(score).toFixed(1);
    }

    /**
     * Group key (the source) for a pair: its URI when present, else its label.
     * @param {Object} pair - A candidate pair.
     * @returns {string} The parent/group id.
     */
    function sourceKey(pair) {
        if (pair.srcUri) {
            return pair.srcUri;
        }
        return pair.srcLabel;
    }

    /**
     * Builds the jsTree child node id for a pair (source key + target URI).
     * @param {Object} pair - A candidate pair.
     * @returns {string} The node id.
     */
    function pairNodeId(pair) {
        return sourceKey(pair) + NODE_ID_SEPARATOR + pair.tgtUri;
    }

    /**
     * Groups pairs by source. Preserves first-seen order.
     * @param {Array} pairs - Candidate pairs.
     * @returns {Array} [{ key, label, pairs: [] }]
     */
    function groupBySource(pairs) {
        var order = [];
        var byKey = {};
        (pairs || []).forEach(function (pair) {
            var key = sourceKey(pair);
            if (!byKey[key]) {
                byKey[key] = { key: key, label: pair.srcLabel, pairs: [] };
                order.push(key);
            }
            byKey[key].pairs.push(pair);
        });
        return order.map(function (key) {
            return byKey[key];
        });
    }

    /**
     * Splits MakeSimilars candidate pairs into exact vs non-exact matches.
     * @param {Object} bulkSimilars - { srcLabel: { tgtUri: { label, score } } }
     * @param {Object} fromWordsMap - { srcLabel: srcUri }
     * @returns {{exact: Array, nonExact: Array}} Pairs { srcUri, srcLabel, tgtUri, tgtLabel, score }.
     */
    self.splitExactMatches = function (bulkSimilars, fromWordsMap) {
        var exact = [];
        var nonExact = [];
        var bulk = bulkSimilars || {};
        var fromMap = fromWordsMap || {};
        Object.keys(bulk).forEach(function (srcLabel) {
            var srcUri = fromMap[srcLabel];
            if (!srcUri) {
                srcUri = null;
            }
            var targets = bulk[srcLabel] || {};
            Object.keys(targets).forEach(function (tgtUri) {
                var pair = {
                    srcUri: srcUri,
                    srcLabel: srcLabel,
                    tgtUri: tgtUri,
                    tgtLabel: targets[tgtUri].label,
                    score: targets[tgtUri].score,
                };
                if (matchesCaseAndPlural(srcLabel, pair.tgtLabel)) {
                    exact.push(pair);
                } else {
                    nonExact.push(pair);
                }
            });
        });
        return { exact: exact, nonExact: nonExact };
    };

    /**
     * Renders exact pairs as a checkbox jsTree GROUPED BY SOURCE: parent = source label,
     * children = target labels (+score), all checked by default. Unchecking a child (or a whole
     * source) excludes that pair from equivalentClass generation.
     * @param {string} divId - The container div id for the jsTree.
     * @param {Array} exactPairs - The exact pairs to display.
     * @param {Object} [headerInfo] - { headerDivId, sourceName, targetName } for the dynamic header line.
     * @param {function} [onReady] - Called once the tree is loaded and checked.
     * @returns {void}
     */
    self.renderValidation = function (divId, exactPairs, headerInfo, onReady) {
        self._validationDivId = divId;
        self._pairByNodeId = {};
        // Reveal this step's section (hidden by default so steps appear in sequence).
        $("#" + divId).parent().show();

        // Header line: "<source name>  →  <target source name>".
        if (headerInfo && headerInfo.headerDivId) {
            var sourceName = headerInfo.sourceName;
            if (!sourceName) {
                sourceName = "source";
            }
            var targetName = headerInfo.targetName;
            if (!targetName) {
                targetName = "target";
            }
            $("#" + headerInfo.headerDivId).html(escapeHtml(sourceName) + "&nbsp;&nbsp;&rarr;&nbsp;&nbsp;" + escapeHtml(targetName));
        }

        var jstreeData = [];
        groupBySource(exactPairs).forEach(function (group) {
            jstreeData.push({
                id: group.key,
                parent: "#",
                text: escapeHtml(group.label),
                state: { opened: true },
                data: { type: "source" },
            });
            group.pairs.forEach(function (pair) {
                var nodeId = pairNodeId(pair);
                self._pairByNodeId[nodeId] = pair;
                var text = "<span style='display:inline-block;min-width:240px'>" + escapeHtml(pair.tgtLabel) + "</span>";
                text += "<span style='color:#888'>" + formatScore(pair.score) + "</span>";
                jstreeData.push({
                    id: nodeId,
                    parent: group.key,
                    text: text,
                    data: { type: "pair", pair: pair },
                });
            });
        });

        var options = { withCheckboxes: true, selectDescendants: true };
        window.JstreeWidget.loadJsTree(divId, jstreeData, options, function () {
            var tree = $("#" + divId).jstree(true);
            if (tree && tree.check_all) {
                tree.check_all();
            }
            if (onReady) {
                onReady();
            }
        });
    };

    /**
     * Reads the validation jsTree and splits PAIR nodes into checked (validated) and unchecked.
     * Parent (source) nodes are ignored; only the leaf pair nodes carry equivalences.
     * @param {string} [divId] - The container div id (defaults to the last rendered one).
     * @returns {{checked: Array, unchecked: Array}} The validated and excluded pairs.
     */
    self.getValidatedSplit = function (divId) {
        var targetDiv = divId;
        if (!targetDiv) {
            targetDiv = self._validationDivId;
        }
        var tree = $("#" + targetDiv).jstree(true);
        var checkedIds = [];
        if (tree) {
            checkedIds = tree.get_checked();
        }
        var checkedSet = {};
        checkedIds.forEach(function (id) {
            checkedSet[id] = 1;
        });

        var checked = [];
        var unchecked = [];
        Object.keys(self._pairByNodeId).forEach(function (nodeId) {
            var pair = self._pairByNodeId[nodeId];
            if (checkedSet[nodeId]) {
                checked.push(pair);
            } else {
                unchecked.push(pair);
            }
        });
        return { checked: checked, unchecked: unchecked };
    };

    /**
     * Inserts owl:equivalentClass triples (source class -> target class) for the given pairs,
     * written into the source's named graph.
     * @param {string} source - The source (source 1) whose graph receives the triples.
     * @param {Array} pairs - Validated pairs with srcUri / tgtUri.
     * @param {function} callback - callback(err, insertedCount).
     * @returns {void}
     */
    self.generateEquivalentClasses = function (source, pairs, callback) {
        if (!pairs || pairs.length === 0) {
            return callback(null, 0);
        }
        var triples = [];
        pairs.forEach(function (pair) {
            if (pair.srcUri && pair.tgtUri) {
                triples.push({ subject: pair.srcUri, predicate: OWL_EQUIVALENT_CLASS, object: pair.tgtUri });
            }
        });
        if (triples.length === 0) {
            return callback(null, 0);
        }
        window.Sparql_generic.insertTriples(source, triples, {}, function (err) {
            if (err) {
                return callback(err);
            }
            callback(null, triples.length);
        });
    };

    /**
     * Renders the non-exact pairs GROUPED BY SOURCE (one row per source, its targets listed).
     * @param {string} divId - The container div id.
     * @param {Array} nonExactPairs - The non-exact pairs.
     * @returns {void}
     */
    self.renderNonExact = function (divId, nonExactPairs) {
        // Reveal this step's section (hidden until "Generate equivalent classes" has run).
        $("#" + divId).parent().show();
        var pairs = nonExactPairs || [];
        if (pairs.length === 0) {
            $("#" + divId).html("<i>no non-exact matches</i>");
            return;
        }
        // Three columns only: source | target | score (one row per pair, nothing else).
        var html = "<table style='border-collapse:collapse;width:100%;'>";
        html += "<thead><tr><th style='text-align:left;border-bottom:1px solid #ccc;'>source</th>";
        html += "<th style='text-align:left;border-bottom:1px solid #ccc;'>target</th>";
        html += "<th style='text-align:right;border-bottom:1px solid #ccc;'>score</th></tr></thead><tbody>";
        pairs.forEach(function (pair) {
            html += "<tr><td>" + escapeHtml(pair.srcLabel) + "</td>";
            html += "<td>" + escapeHtml(pair.tgtLabel) + "</td>";
            html += "<td style='text-align:right;'>" + formatScore(pair.score) + "</td></tr>";
        });
        html += "</tbody></table>";
        $("#" + divId).html(html);
    };

    return self;
})();

export default AlignWorkflow;
if (typeof window !== "undefined") {
    window.AlignWorkflow = AlignWorkflow;
}
