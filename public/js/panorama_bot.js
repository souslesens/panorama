// Panorama alignment bot: orchestrates the steps downstream of MakeSimilars.bulkSimilars.
// split (case + plural) -> validate exacts (checkbox jsTree grouped by source) -> equivalentClass -> non-exacts.
// BotEngineClass is a core SLS module, imported by absolute path (the plugin is served under /plugins/).
import BotEngineClass from "/vocables/modules/bots/_botEngineClass.js";
import AlignWorkflow from "./alignWorkflow.js";

var Panorama_bot = (function () {
    var self = {};
    self.myBotEngine = new BotEngineClass();

    /**
     * Starts the alignment bot.
     * @param {Object} [workflow] - Optional workflow override.
     * @param {Object} _params - { bulkSimilars, fromWordsMap, source, targetSource, botDivId, validationDivId, nonExactDivId }.
     * @param {function} [callbackFn] - Optional end callback.
     * @returns {void}
     */
    self.start = function (workflow, _params, callbackFn) {
        self.title = "Panorama alignment";
        if (_params && _params.title) {
            self.title = _params.title;
        }
        var startParams = self.myBotEngine.fillStartParams(arguments);

        if (!workflow) {
            workflow = self.workflow;
        }
        self.params = {
            bulkSimilars: {},
            fromWordsMap: {},
            source: null,
            targetSource: null,
            validationDivId: "Panorama_validationDiv",
            nonExactDivId: "Panorama_nonExactDiv",
            exact: [],
            nonExact: [],
        };

        var initOptions = null;
        if (_params && _params.botDivId) {
            initOptions = { divId: _params.botDivId };
        }

        self.myBotEngine.init(Panorama_bot, workflow, initOptions, function () {
            self.myBotEngine.startParams = startParams;
            if (_params) {
                for (var key in _params) {
                    self.params[key] = _params[key];
                }
            }
            self.myBotEngine.nextStep();
        });
    };

    self.workflow = {
        startFn: {
            splitFn: {
                showValidationFn: {
                    _OR: {
                        "Generate equivalent classes": { generateEquivalentClassFn: { showNonExactFn: { endFn: {} } } },
                    },
                },
            },
        },
    };

    self.functionTitles = {
        startFn: "Label alignment",
        splitFn: "Split exact / non-exact (case + plural)",
        showValidationFn: "Validate exact matches (uncheck to exclude)",
        generateEquivalentClassFn: "Generate equivalent classes",
        showNonExactFn: "Show non-exact matches",
    };

    self.functions = {
        startFn: function () {
            self.myBotEngine.nextStep();
        },
        endFn: function () {
            self.myBotEngine.end();
        },
        splitFn: function () {
            var result = AlignWorkflow.splitExactMatches(self.params.bulkSimilars, self.params.fromWordsMap);
            self.params.exact = result.exact;
            self.params.nonExact = result.nonExact;
            self.myBotEngine.nextStep();
        },
        showValidationFn: function () {
            // Sequence: hide the non-exacts section until equivalentClass generation has run.
            $("#" + self.params.nonExactDivId).parent().hide();
            var headerInfo = {
                headerDivId: "Panorama_validationHeader",
                sourceName: self.params.source,
                targetName: self.params.targetSource,
            };
            AlignWorkflow.renderValidation(self.params.validationDivId, self.params.exact, headerInfo, function () {
                self.myBotEngine.nextStep();
            });
        },
        generateEquivalentClassFn: function () {
            var split = AlignWorkflow.getValidatedSplit(self.params.validationDivId);
            // Unchecked exact pairs are demoted to non-exacts.
            self.params.nonExact = self.params.nonExact.concat(split.unchecked);
            AlignWorkflow.generateEquivalentClasses(self.params.source, split.checked, function (err, insertedCount) {
                if (err) {
                    var message = err.message;
                    if (!message) {
                        message = err;
                    }
                    window.UI.message("Error inserting equivalentClass: " + message, true);
                    return;
                }
                window.UI.message(insertedCount + " equivalent classes generated in " + self.params.source, true);
                self.myBotEngine.nextStep();
            });
        },
        showNonExactFn: function () {
            AlignWorkflow.renderNonExact(self.params.nonExactDivId, self.params.nonExact);
            self.myBotEngine.nextStep();
        },
    };

    return self;
})();

export default Panorama_bot;
window.Panorama_bot = Panorama_bot;
