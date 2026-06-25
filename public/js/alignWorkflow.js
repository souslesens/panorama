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
    // Definitions of the non-exact classes, fetched from SousLeSens: { from: [{uri,label,definition}], target: [...] }
    self.definitions = null;

    // Number of class URIs per SPARQL query (keeps the GET URL short enough).
    var DEFINITIONS_BATCH_SIZE = 60;
    // Predicate-name fragments that identify a textual definition (mirrors Sparql_common.isTripleObjectString).
    var DEFINITION_PREDICATE_HINTS = ["definition", "comment", "description"];

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
     * Renders exact pairs as a flat checkbox jsTree: one node per pair, two aligned columns
     * (source label | target label | score), all checked by default. Unchecking a pair excludes it
     * from equivalentClass generation.
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

        // Column header: source name | target source name | score (aligned with the node columns).
        if (headerInfo && headerInfo.headerDivId) {
            var sourceName = headerInfo.sourceName;
            if (!sourceName) {
                sourceName = "source";
            }
            var targetName = headerInfo.targetName;
            if (!targetName) {
                targetName = "target";
            }
            var headerHtml = "<span style='display:inline-block;min-width:220px'>" + escapeHtml(sourceName) + "</span>";
            headerHtml += "<span style='display:inline-block;min-width:220px'>" + escapeHtml(targetName) + "</span>";
            headerHtml += "<span>score</span>";
            $("#" + headerInfo.headerDivId).html(headerHtml);
        }

        // Flat: one checkable node per pair, two aligned columns (source label | target label | score).
        var jstreeData = [];
        exactPairs.forEach(function (pair) {
            var nodeId = pairNodeId(pair);
            self._pairByNodeId[nodeId] = pair;
            var text = "<span style='display:inline-block;min-width:220px'>" + escapeHtml(pair.srcLabel) + "</span>";
            text += "<span style='display:inline-block;min-width:220px'>" + escapeHtml(pair.tgtLabel) + "</span>";
            text += "<span style='color:#888'>" + formatScore(pair.score) + "</span>";
            jstreeData.push({
                id: nodeId,
                parent: "#",
                text: text,
                data: { type: "pair", pair: pair },
            });
        });

        var options = { withCheckboxes: true };
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

    /**
     * Builds the SPARQL SELECT returning a textual definition for a batch of class URIs of one source.
     * Keeps any predicate whose name contains "definition", "comment" or "description".
     * @param {string} source - The source name (key of Config.sources).
     * @param {Array} uris - Class URIs for this batch.
     * @returns {string} The SPARQL query.
     */
    function buildDefinitionsQuery(source, uris) {
        var fromStr = window.Sparql_common.getFromStr(source);
        var values = uris
            .map(function (u) {
                return "<" + u + ">";
            })
            .join(" ");
        var predFilters = DEFINITION_PREDICATE_HINTS.map(function (hint) {
            return "CONTAINS(LCASE(STR(?p)), \"" + hint + "\")";
        }).join(" || ");
        var query = "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> ";
        query += "SELECT DISTINCT ?class ?def " + fromStr + " WHERE { ";
        query += "VALUES ?class { " + values + " } ";
        query += "?class ?p ?def . ";
        query += "FILTER(isLiteral(?def)) ";
        query += "FILTER(" + predFilters + ") ";
        query += "} LIMIT 10000";
        return query;
    }

    /**
     * Fetches the first textual definition found for each class URI of a single source, in batches.
     * @param {string} source - The source name.
     * @param {Array} classUris - The class URIs to look up.
     * @param {function} callback - callback(err, { uri: definitionText }).
     * @returns {void}
     */
    self.fetchDefinitions = function (source, classUris, callback) {
        var definitionsByUri = {};
        if (!classUris || classUris.length === 0) {
            return callback(null, definitionsByUri);
        }
        var serverUrl = window.Config.sources[source].sparql_server.url;
        var url = serverUrl + "?format=json&query=";
        if (window.Config.sources[source].sparql_server.no_params) {
            url = serverUrl;
        }
        var index = 0;
        function nextBatch() {
            if (index >= classUris.length) {
                return callback(null, definitionsByUri);
            }
            var batch = classUris.slice(index, index + DEFINITIONS_BATCH_SIZE);
            index += DEFINITIONS_BATCH_SIZE;
            var query = buildDefinitionsQuery(source, batch);
            window.Sparql_proxy.querySPARQL_GET_proxy(url, query, "", { source: source }, function (err, result) {
                if (err) {
                    return callback(err);
                }
                result.results.bindings.forEach(function (binding) {
                    var uri = binding.class.value;
                    // Keep the first non-empty definition found per class.
                    if (!definitionsByUri[uri] && binding.def && binding.def.value) {
                        definitionsByUri[uri] = binding.def.value;
                    }
                });
                nextBatch();
            });
        }
        nextBatch();
    };

    /**
     * Builds the in-memory definitions structure for the classes involved in the non-exact pairs
     * (source + target): fetches each class definition from SousLeSens and stores it in self.definitions.
     * Not displayed — this data feeds the upcoming LLM classification step.
     * @param {string} fromSource - Source-from name.
     * @param {string} targetSource - Target source name.
     * @param {Array} pairs - Non-exact pairs ({ srcUri, srcLabel, tgtUri, tgtLabel }).
     * @param {function} callback - callback(err, definitions).
     * @returns {void}
     */
    self.buildDefinitions = function (fromSource, targetSource, pairs, callback) {
        var fromLabelByUri = {};
        var targetLabelByUri = {};
        (pairs || []).forEach(function (pair) {
            if (pair.srcUri) {
                fromLabelByUri[pair.srcUri] = pair.srcLabel;
            }
            if (pair.tgtUri) {
                targetLabelByUri[pair.tgtUri] = pair.tgtLabel;
            }
        });
        var fromUris = Object.keys(fromLabelByUri);
        var targetUris = Object.keys(targetLabelByUri);

        self.fetchDefinitions(fromSource, fromUris, function (errFrom, fromDefs) {
            if (errFrom) {
                return callback(errFrom);
            }
            self.fetchDefinitions(targetSource, targetUris, function (errTarget, targetDefs) {
                if (errTarget) {
                    return callback(errTarget);
                }
                var definitions = { from: [], target: [] };
                fromUris.forEach(function (uri) {
                    var def = fromDefs[uri];
                    if (!def) {
                        def = "";
                    }
                    definitions.from.push({ uri: uri, label: fromLabelByUri[uri], definition: def });
                });
                targetUris.forEach(function (uri) {
                    var def = targetDefs[uri];
                    if (!def) {
                        def = "";
                    }
                    definitions.target.push({ uri: uri, label: targetLabelByUri[uri], definition: def });
                });
                self.definitions = definitions;
                callback(null, definitions);
            });
        });
    };

    /**
     * Renders the AI-treatment result: model, token usage, per-category counts and the per-pair table.
     * @param {string} divId - The container div id.
     * @param {Object} response - The /api/v1/alignment response.
     * @returns {void}
     */
    function renderAiTreatment(divId, response) {
        $("#" + divId).parent().show();
        var counts = response.counts || {};
        var usage = response.usage || {};
        var inputTokens = usage.input_tokens || 0;
        var outputTokens = usage.output_tokens || 0;
        var totalTokens = inputTokens + outputTokens;
        var html = "<div style='margin-bottom:6px;'>";
        html += "<b>Model:</b> " + escapeHtml(response.model || "") + "<br>";
        html += "<b>Tokens used:</b> " + totalTokens + " (" + inputTokens + " in + " + outputTokens + " out)</div>";

        html += "<div style='margin-bottom:6px;'>";
        ["Exact match AI", "SubclassOf", "SubclassOf inverse", "Not match", "Unknown", "Other"].forEach(function (category) {
            var value = counts[category];
            if (!value) {
                value = 0;
            }
            html += "<span style='margin-right:12px;'>" + escapeHtml(category) + ": <b>" + value + "</b></span>";
        });
        html += "</div>";

        if (response.parseError) {
            html += "<div style='color:#c00;'>parse error: " + escapeHtml(response.parseError) + "</div>";
        }

        var classifications = response.classifications || [];
        html += "<table style='border-collapse:collapse;width:100%;'>";
        html += "<thead><tr>";
        html += "<th style='text-align:left;border-bottom:1px solid #ccc;'>source</th>";
        html += "<th style='text-align:left;border-bottom:1px solid #ccc;'>target</th>";
        html += "<th style='text-align:left;border-bottom:1px solid #ccc;'>AI category</th>";
        html += "<th style='text-align:left;border-bottom:1px solid #ccc;'>reason</th>";
        html += "</tr></thead><tbody>";
        classifications.forEach(function (item) {
            html += "<tr><td style='vertical-align:top;'>" + escapeHtml(item.srcLabel) + "</td>";
            html += "<td style='vertical-align:top;'>" + escapeHtml(item.tgtLabel) + "</td>";
            html += "<td style='vertical-align:top;white-space:nowrap;'>" + escapeHtml(item.category) + "</td>";
            html += "<td>" + escapeHtml(item.reason) + "</td></tr>";
        });
        html += "</tbody></table>";
        $("#" + divId).html(html);
    }

    /**
     * Runs the AI treatment: POSTs the non-exact pairs and the definitions table to the AI route
     * (single model = the one configured in mainConfig.llm), stores the result in self.aiTreatment
     * and renders it (model, token usage, per-category counts and the per-pair classification table).
     * @param {string} fromSource - Source-from name (unused server-side but kept for symmetry/logging).
     * @param {string} targetSource - Target source name.
     * @param {Array} nonExacts - Non-exact pairs.
     * @param {Object} definitions - { from: [...], target: [...] }.
     * @param {string} divId - The container div id for the result.
     * @param {function} callback - callback(err, response).
     * @returns {void}
     */
    self.runAiTreatment = function (fromSource, targetSource, nonExacts, definitions, divId, callback) {
        var payload = {
            nonExacts: nonExacts,
            definitions: definitions,
        };
        $.ajax({
            url: window.Config.apiUrl + "/alignment",
            type: "POST",
            contentType: "application/json",
            data: JSON.stringify(payload),
            dataType: "json",
            success: function (response) {
                self.aiTreatment = response;
                renderAiTreatment(divId, response);
                callback(null, response);
            },
            error: function (jqXHR) {
                var message = "AI treatment failed";
                if (jqXHR && jqXHR.responseJSON && jqXHR.responseJSON.error) {
                    message = jqXHR.responseJSON.error;
                }
                callback(new Error(message));
            },
        });
    };

    return self;
})();

export default AlignWorkflow;
if (typeof window !== "undefined") {
    window.AlignWorkflow = AlignWorkflow;
}
