/*
 * Copyright (c) 2013 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global brackets, define, $, Mustache, Promise */

define(function (require, exports, module) {
    "use strict";
    
    var _                           = require("thirdparty/lodash"),
        Dialogs                     = require("widgets/Dialogs"),
        DefaultDialogs              = require("widgets/DefaultDialogs"),
        FileSystem                  = require("filesystem/FileSystem"),
        FileUtils                   = require("file/FileUtils"),
        Package                     = require("extensibility/Package"),
        Strings                     = require("strings"),
        StringUtils                 = require("utils/StringUtils"),
        Commands                    = require("command/Commands"),
        CommandManager              = require("command/CommandManager"),
        InstallExtensionDialog      = require("extensibility/InstallExtensionDialog"),
        AppInit                     = require("utils/AppInit"),
        Async                       = require("utils/Async"),
        KeyEvent                    = require("utils/KeyEvent"),
        ExtensionManager            = require("extensibility/ExtensionManager"),
        ExtensionManagerView        = require("extensibility/ExtensionManagerView").ExtensionManagerView,
        ExtensionManagerViewModel   = require("extensibility/ExtensionManagerViewModel");
    
    var dialogTemplate    = require("text!htmlContent/extension-manager-dialog.html");
    
    // bootstrap tabs component
    require("widgets/bootstrap-tab");
    
    var _activeTabIndex;

    function _stopEvent(event) {
        event.stopPropagation();
        event.preventDefault();
    }

    /**
     * @private
     * Triggers changes requested by the dialog UI.
     */
    function _performChanges() {
        // If an extension was removed or updated, prompt the user to quit Brackets.
        var hasRemovedExtensions = ExtensionManager.hasExtensionsToRemove(),
            hasUpdatedExtensions = ExtensionManager.hasExtensionsToUpdate();
        if (!hasRemovedExtensions && !hasUpdatedExtensions) {
            return;
        }
        
        var buttonLabel = Strings.CHANGE_AND_RELOAD;
        if (hasRemovedExtensions && !hasUpdatedExtensions) {
            buttonLabel = Strings.REMOVE_AND_RELOAD;
        } else if (hasUpdatedExtensions && !hasRemovedExtensions) {
            buttonLabel = Strings.UPDATE_AND_RELOAD;
        }
        
        var dlg = Dialogs.showModalDialog(
            DefaultDialogs.DIALOG_ID_CHANGE_EXTENSIONS,
            Strings.CHANGE_AND_RELOAD_TITLE,
            Strings.CHANGE_AND_RELOAD_MESSAGE,
            [
                {
                    className : Dialogs.DIALOG_BTN_CLASS_NORMAL,
                    id        : Dialogs.DIALOG_BTN_CANCEL,
                    text      : Strings.CANCEL
                },
                {
                    className : Dialogs.DIALOG_BTN_CLASS_PRIMARY,
                    id        : Dialogs.DIALOG_BTN_OK,
                    text      : buttonLabel
                }
            ],
            false
        ),
            $dlg = dlg.getElement();
        
        $dlg.one("buttonClick", function (e, buttonId) {
            if (buttonId === Dialogs.DIALOG_BTN_OK) {
                // Disable the dialog buttons so the user can't dismiss it,
                // and show a message indicating that we're doing the updates,
                // in case it takes a long time.
                $dlg.find(".dialog-button").prop("disabled", true);
                $dlg.find(".close").hide();
                $dlg.find(".dialog-message")
                    .text(Strings.PROCESSING_EXTENSIONS)
                    .append("<span class='spinner inline spin'/>");
                
                ExtensionManager.removeMarkedExtensions()
                    .then(function () {
                        ExtensionManager.updateExtensions()
                            .then(function () {
                                dlg.close();
                                CommandManager.execute(Commands.APP_RELOAD);
                            })
                            .catch(function (errorArray) {
                                dlg.close();
                                
                                // This error case should be very uncommon.
                                // Just let the user know that we couldn't update
                                // this extension and log the errors to the console.
                                var ids = [];
                                errorArray.forEach(function (errorObj) {
                                    ids.push(errorObj.item);
                                    if (errorObj.error && errorObj.error.forEach) {
                                        console.error("Errors for", errorObj.item);
                                        errorObj.error.forEach(function (error) {
                                            console.error(Package.formatError(error));
                                        });
                                    } else {
                                        console.error("Error for", errorObj.item, errorObj);
                                    }
                                });
                                Dialogs.showModalDialog(
                                    DefaultDialogs.DIALOG_ID_ERROR,
                                    Strings.EXTENSION_MANAGER_UPDATE,
                                    StringUtils.format(Strings.EXTENSION_MANAGER_UPDATE_ERROR, ids.join(", "))
                                ).then(function () {
                                    // We still have to reload even if some of the removals failed.
                                    CommandManager.execute(Commands.APP_RELOAD);
                                });
                            });
                    })
                    .catch(function (errorArray) {
                        dlg.close();
                        ExtensionManager.cleanupUpdates();
                        
                        var ids = [];
                        errorArray.forEach(function (errorObj) {
                            ids.push(errorObj.item);
                        });
                        Dialogs.showModalDialog(
                            DefaultDialogs.DIALOG_ID_ERROR,
                            Strings.EXTENSION_MANAGER_REMOVE,
                            StringUtils.format(Strings.EXTENSION_MANAGER_REMOVE_ERROR, ids.join(", "))
                        ).then(function () {
                            // We still have to reload even if some of the removals failed.
                            CommandManager.execute(Commands.APP_RELOAD);
                        });
                    });
            } else {
                dlg.close();
                ExtensionManager.cleanupUpdates();
                ExtensionManager.unmarkAllForRemoval();
            }
        });
    }
    
    
    /**
     * @private
     * Install extensions from the local file system using the install dialog.
     * @return {Promise}
     */
    function _installUsingDragAndDrop() {
        
        return new Promise(function (resolve, reject) {

            var installZips = [],
                updateZips = [],
                validatePromise;

            brackets.app.getDroppedFiles(function (err, paths) {
                if (err) {
                    // Only possible error is invalid params, silently ignore
                    console.error(err);
                    resolve();
                    return;
                }

                // Parse zip files and separate new installs vs. updates
                validatePromise = Async.doInParallel_aggregateErrors(paths, function (path) {
                    
                    return new Promise(function (innerResolve, innerReject) {

                        FileSystem.resolve(path, function (err, file) {
                            var extension = FileUtils.getFileExtension(path),
                                isZip = file.isFile && (extension === "zip"),
                                errStr;

                            if (err) {
                                errStr = FileUtils.getFileErrorString(err);
                            } else if (!isZip) {
                                errStr = Strings.INVALID_ZIP_FILE;
                            }

                            if (errStr) {
                                innerReject(errStr);
                                return;
                            }

                            // Call validate() so that we open the local zip file and parse the
                            // package.json. We need the name to detect if this zip will be a
                            // new install or an update.
                            Package.validate(path, { requirePackageJSON: true }).then(function (info) {
                                if (info.errors.length) {
                                    innerReject(Package.formatError(info.errors));
                                    return;
                                }

                                var extensionName = info.metadata.name,
                                    extensionInfo = ExtensionManager.extensions[extensionName],
                                    isUpdate = extensionInfo && !!extensionInfo.installInfo;

                                if (isUpdate) {
                                    updateZips.push(file);
                                } else {
                                    installZips.push(file);
                                }

                                innerResolve();
                            }).catch(function (err) {
                                innerReject(Package.formatError(err));
                            });
                        });
                    });
                });

                validatePromise.then(function () {
                    var installPromise = Async.doSequentially(installZips, function (file) {
                        return InstallExtensionDialog.installUsingDialog(file);
                    });

                    var updatePromise = installPromise.then(function () {
                        return Async.doSequentially(updateZips, function (file) {
                            return InstallExtensionDialog.updateUsingDialog(file).then(function (result) {
                                ExtensionManager.updateFromDownload(result);
                            });
                        });
                    });

                    // InstallExtensionDialog displays it's own errors, always
                    // resolve the outer promise
                    updatePromise.then(resolve, resolve);
                }).catch(function (errorArray) {
                    reject(errorArray);
                });
            });
        });
    }
    
    /**
     * @private
     * Show a dialog that allows the user to browse and manage extensions.
     */
    function _showDialog() {
        var dialog,
            $dlg,
            views   = [],
            $search,
            $searchClear,
            context = { Strings: Strings, showRegistry: !!brackets.config.extension_registry },
            models  = [];
        
        // Load registry only if the registry URL exists
        if (context.showRegistry) {
            models.push(new ExtensionManagerViewModel.RegistryViewModel());
            models.push(new ExtensionManagerViewModel.ThemesViewModel());
        }
        
        models.push(new ExtensionManagerViewModel.InstalledViewModel());
        
        function updateSearchDisabled() {
            var model           = models[_activeTabIndex],
                searchDisabled  = ($search.val() === "") &&
                                  (!model.filterSet || model.filterSet.length === 0);
            
            $search.prop("disabled", searchDisabled);
            $searchClear.prop("disabled", searchDisabled);
            
            return searchDisabled;
        }
        
        // Open the dialog
        dialog = Dialogs.showModalDialogUsingTemplate(Mustache.render(dialogTemplate, context));
        
        // On dialog close: clean up listeners & models, and commit changes
        dialog.then(function () {
            $(document).off(".extensionManager");
            
            models.forEach(function (model) {
                model.dispose();
            });
            
            _performChanges();
        });
        
        // Create the view.
        $dlg = dialog.getElement();
        $search = $(".search", $dlg);
        $searchClear = $(".search-clear", $dlg);

        function setActiveTab($tab) {
            models[_activeTabIndex].scrollPos = $(".modal-body", $dlg).scrollTop();
            $tab.tab("show");
            $(".modal-body", $dlg).scrollTop(models[_activeTabIndex].scrollPos || 0);
            $searchClear.click();
        }

        // Dialog tabs
        $dlg.find(".nav-tabs a")
            .on("click", function (event) {
                setActiveTab($(this));
            });

        // Navigate through tabs via Ctrl-(Shift)-Tab
        // (focus may be on document.body if text in extension listing clicked - see #9511)
        $(document).on("keyup.extensionManager", function (event) {
            if (event.keyCode === KeyEvent.DOM_VK_TAB && event.ctrlKey) {
                var $tabs = $(".nav-tabs a", $dlg),
                    tabIndex = _activeTabIndex;

                if (event.shiftKey) {
                    tabIndex--;
                } else {
                    tabIndex++;
                }
                tabIndex %= $tabs.length;
                setActiveTab($tabs.eq(tabIndex));
            }
        });

        // Update & hide/show the notification overlay on a tab's icon, based on its model's notifyCount
        function updateNotificationIcon(index) {
            var model = models[index],
                $notificationIcon = $dlg.find(".nav-tabs li").eq(index).find(".notification");
            if (model.notifyCount) {
                $notificationIcon.text(model.notifyCount);
                $notificationIcon.show();
            } else {
                $notificationIcon.hide();
            }
        }
        
        // Initialize models and create a view for each model
        var modelInitPromise = Async.doInParallel(models, function (model, index) {
            var view    = new ExtensionManagerView(),
                promise = view.initialize(model),
                lastNotifyCount;
            
            var fnAlways = function () {
                views[index] = view;
                lastNotifyCount = model.notifyCount;
                updateNotificationIcon(index);
            };
            promise.then(fnAlways, fnAlways);
            
            $(model).on("change", function () {
                if (lastNotifyCount !== model.notifyCount) {
                    lastNotifyCount = model.notifyCount;
                    updateNotificationIcon(index);
                }
            });
            
            return promise;
        }, true);
        
        var fnAlwaysModelInit = function () {
            $(".spinner", $dlg).remove();
            
            views.forEach(function (view) {
                view.$el.appendTo($(".modal-body", $dlg));
            });
            
            // Update search UI before new tab is shown
            $("a[data-toggle='tab']", $dlg).each(function (index, tabElement) {
                $(tabElement).on("show", function (event) {
                    _activeTabIndex = index;
                    
                    // Focus the search input
                    if (!updateSearchDisabled()) {
                        $dlg.find(".search").focus();
                    }
                });
            });
            
            // Filter the views when the user types in the search field.
            $dlg.on("input", ".search", function (e) {
                var query = $(this).val();
                views.forEach(function (view) {
                    view.filter(query);
                });
            }).on("click", ".search-clear", function (e) {
                $search.val("");
                views.forEach(function (view, index) {
                    view.filter("");
                });
                
                if (!updateSearchDisabled()) {
                    $search.focus();
                }
            });
            
            // Disable the search field when there are no items in the model
            models.forEach(function (model, index) {
                $(model).on("change", function () {
                    if (_activeTabIndex === index) {
                        updateSearchDisabled();
                    }
                });
            });
            
            // Open dialog to Installed tab if extension updates are available
            if ($("#toolbar-extension-manager").hasClass('updatesAvailable')) {
                $dlg.find(".nav-tabs a.installed").tab("show");
            } else { // Otherwise show the first tab
                $dlg.find(".nav-tabs a:first").tab("show");
            }
        };
        modelInitPromise.then(fnAlwaysModelInit, fnAlwaysModelInit);
    
        // Handle the install button.
        $(".extension-manager-dialog .install-from-url")
            .click(function () {
                InstallExtensionDialog.showDialog().then(ExtensionManager.updateFromDownload);
            });
        
        // Handle the drag/drop zone
        var $dropzone = $("#install-drop-zone"),
            $dropmask = $("#install-drop-zone-mask");
        
        $dropzone
            .on("dragover", function (event) {
                _stopEvent(event);

                if (!event.originalEvent.dataTransfer.files) {
                    return;
                }

                var items = event.originalEvent.dataTransfer.items,
                    isValidDrop = false;

                isValidDrop = _.every(items, function (item) {
                    if (item.kind === "file") {
                        var entry = item.webkitGetAsEntry(),
                            extension = FileUtils.getFileExtension(entry.fullPath);

                        return entry.isFile && extension === "zip";
                    }

                    return false;
                });

                if (isValidDrop) {
                    // Set an absolute width to stabilize the button size
                    $dropzone.width($dropzone.width());

                    // Show drop styling and message
                    $dropzone.removeClass("drag");
                    $dropzone.addClass("drop");
                } else {
                    event.originalEvent.dataTransfer.dropEffect = "none";
                }
            })
            .on("drop", _stopEvent);
        
        $dropmask
            .on("dragover", function (event) {
                _stopEvent(event);
                event.originalEvent.dataTransfer.dropEffect = "copy";
            })
            .on("dragleave", function () {
                $dropzone.removeClass("drop");
                $dropzone.addClass("drag");
            })
            .on("drop", function (event) {
                _stopEvent(event);
                
                if (event.originalEvent.dataTransfer.files) {
                    // Attempt install
                    _installUsingDragAndDrop().catch(function (errorArray) {
                        var message = Strings.INSTALL_EXTENSION_DROP_ERROR;

                        message += "<ul class='dialog-list'>";
                        errorArray.forEach(function (info) {
                            message += "<li><span class='dialog-filename'>";
                            message += StringUtils.breakableUrl(info.item);
                            message += "</span>: " + info.error + "</li>";
                        });
                        message += "</ul>";

                        Dialogs.showModalDialog(
                            DefaultDialogs.DIALOG_ID_ERROR,
                            Strings.EXTENSION_MANAGER_TITLE,
                            message
                        );
                        
                        $dropzone.removeClass("validating");
                        $dropzone.addClass("drag");
                    }).then(function () {
                        $dropzone.removeClass("validating");
                        $dropzone.addClass("drag");
                    });
                    
                    // While installing, show validating message
                    $dropzone.removeClass("drop");
                    $dropzone.addClass("validating");
                }
            });
        
        return Promise.resolve(dialog);
    }
    
    CommandManager.register(Strings.CMD_EXTENSION_MANAGER, Commands.FILE_EXTENSION_MANAGER, _showDialog);

    AppInit.appReady(function () {
        $("#toolbar-extension-manager").click(_showDialog);
    });
    
    // Unit tests
    exports._performChanges = _performChanges;
});
