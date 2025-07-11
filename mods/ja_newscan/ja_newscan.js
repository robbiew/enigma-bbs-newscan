/* jslint node: true */
'use strict';

//  ENiGMA½
const msgArea = require('../../core/message_area.js');
const MenuModule = require('../../core/menu_module.js').MenuModule;
const ViewController = require('../../core/view_controller.js').ViewController;
const stringFormat = require('../../core/string_format.js');
const FileEntry = require('../../core/file_entry.js');
const FileBaseFilters = require('../../core/file_base_filter.js');
const Errors = require('../../core/enig_error.js').Errors;
const { getAvailableFileAreaTags } = require('../../core/file_base_area.js');
const { valueAsArray } = require('../../core/misc_util.js');

//  deps
const _ = require('lodash');
const async = require('async');

exports.moduleInfo = {
    name: 'New Scan',
    desc: 'Performs a new scan against various areas of the system',
    author: 'NuSkooler',
};

/*
 * * Adapted from original NewScan module to add user configurable newscan areas
*/

const MciCodeIds = {
    ScanStatusLabel: 1, //  TL1
    ScanStatusList: 2, //  VM2 (appends)
};

const Steps = {
    MessageConfs: 'messageConferences',
    FileBase: 'fileBase',

    Finished: 'finished',
};

exports.getModule = class NewScanModule extends MenuModule {
    constructor(options) {
        super(options);

        this.newScanFullExit = _.get(options, 'lastMenuResult.fullExit', false);

        this.currentStep = Steps.MessageConfs;
        this.currentScanAux = {};

        //  :TODO: Make this conf/area specific:
        //  :TODO: Use newer custom info format - TL10+
        const config = this.menuConfig.config;
        this.scanStartFmt = config.scanStartFmt || 'Scanning {confName} - {areaName}...';
        this.scanFinishNoneFmt = config.scanFinishNoneFmt || 'Nothing new in {confName} - {areaName}';
        this.scanFinishNewFmt = config.scanFinishNewFmt || '{count} entries found';
        this.scanCompleteMsg = config.scanCompleteMsg || 'Finished newscan - Press any key to continue';
    }

    updateScanStatus(statusText) {
        // Only clear and write up to 77 columns to avoid overwriting the right border
        const maxWidth = 77;
        const clearLine = ' '.repeat(maxWidth);
        this.setViewText('allViews', MciCodeIds.ScanStatusLabel, clearLine);
        this.setViewText('allViews', MciCodeIds.ScanStatusList, clearLine);
        // Truncate or pad the status text to maxWidth
        const safeStatus = (statusText || '').padEnd(maxWidth).slice(0, maxWidth);
        this.setViewText('allViews', MciCodeIds.ScanStatusLabel, safeStatus);
    }

    newScanMessageConference(cb) {
        //  lazy init
        if (!this.sortedMessageConfs) {
            const getAvailOpts = { includeSystemInternal: true }; //  find new private messages, bulletins, etc.

            this.sortedMessageConfs = _.map(
                msgArea.getAvailableMessageConferences(this.client, getAvailOpts),
                (v, k) => {
                    return {
                        confTag: k,
                        conf: v,
                    };
                }
            );

            //
            //  Sort conferences by name, other than 'system_internal' which should
            //  always come first such that we display private mails/etc. before
            //  other conferences & areas
            //
            this.sortedMessageConfs.sort((a, b) => {
                if ('system_internal' === a.confTag) {
                    return -1;
                } else {
                    return a.conf.name.localeCompare(b.conf.name, {
                        sensitivity: false,
                        numeric: true,
                    });
                }
            });

            this.currentScanAux.conf = this.currentScanAux.conf || 0;
            this.currentScanAux.area = this.currentScanAux.area || 0;
        }

        const currentConf = this.sortedMessageConfs[this.currentScanAux.conf];

        this.newScanMessageArea(currentConf, () => {
            if (this.sortedMessageConfs.length > this.currentScanAux.conf + 1) {
                this.currentScanAux.conf += 1;
                this.currentScanAux.area = 0;

                return this.newScanMessageConference(cb); //  recursive to next conf
            }

            this.updateScanStatus(this.scanCompleteMsg);
            return cb(Errors.DoesNotExist('No more conferences'));
        });
    }

    newScanMessageArea(conf, cb) {
        // Get user's configured newscan areas
        const userNewscanTags = this.client.user.properties['NewScanMessageAreaTags'] || '';
        const selectedAreaTags = userNewscanTags.length > 0 ? userNewscanTags.split(',') : [];

        // If user hasn't configured any areas, fall back to scanning all areas
        const useUserSelection = selectedAreaTags.length > 0;

        //  :TODO: it would be nice to cache this - must be done by conf!
        const omitMessageAreaTags = valueAsArray(
            _.get(this, 'menuConfig.config.omitMessageAreaTags', [])
        );

        let sortedAreas = msgArea
            .getSortedAvailMessageAreasByConfTag(conf.confTag, { client: this.client })
            .filter(area => {
                return !omitMessageAreaTags.includes(area.areaTag);
            });

        // Filter to only user-selected areas if they have configured newscan
        if (useUserSelection) {
            sortedAreas = sortedAreas.filter(area => {
                return selectedAreaTags.includes(area.areaTag);
            });

            // Log for debugging
            this.client.log.debug(
                {
                    confTag: conf.confTag,
                    selectedCount: sortedAreas.length,
                    totalSelected: selectedAreaTags.length
                },
                'Filtering newscan to user-selected areas'
            );
        }

        const currentArea = sortedAreas[this.currentScanAux.area];

        //
        //  Scan and update index until we find something. If results are found,
        //  we'll goto the list module & show them.
        //
        const self = this;
        async.waterfall(
            [
                function checkAndUpdateIndex(callback) {
                    //  Advance to next area if possible
                    if (sortedAreas.length >= self.currentScanAux.area + 1) {
                        self.currentScanAux.area += 1;
                        return callback(null);
                    } else {
                        self.updateScanStatus(self.scanCompleteMsg);
                        return callback(Errors.DoesNotExist('No more areas')); //  this will stop our scan
                    }
                },
                function updateStatusScanStarted(callback) {
                    self.updateScanStatus(
                        stringFormat(self.scanStartFmt, {
                            confName: conf.conf.name,
                            confDesc: conf.conf.desc,
                            areaName: currentArea.area.name,
                            areaDesc: currentArea.area.desc,
                        })
                    );
                    return callback(null);
                },
                function getNewMessagesCountInArea(callback) {
                    msgArea.getNewMessageCountInAreaForUser(
                        self.client.user.userId,
                        currentArea.areaTag,
                        (err, newMessageCount) => {
                            callback(err, newMessageCount);
                        }
                    );
                },
                function displayMessageList(newMessageCount) {
                    if (newMessageCount <= 0) {
                        self.updateScanStatus(
                            stringFormat(self.scanFinishNoneFmt, {
                                confName: conf.conf.name,
                                areaName: currentArea.area.name
                            })
                        );
                        // Add a very brief pause before moving to next area
                        setTimeout(() => {
                            self.newScanMessageArea(conf, cb);
                        }, 100); // 0.1 second pause
                        return;
                    }

                    const nextModuleOpts = {
                        extraArgs: {
                            messageAreaTag: currentArea.areaTag,
                        },
                    };

                    return self.gotoMenu(
                        self.menuConfig.config.newScanMessageList || 'newScanMessageList',
                        nextModuleOpts
                    );
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    newScanFileBase(cb) {
        //  :TODO: add in steps
        const omitFileAreaTags = valueAsArray(
            _.get(this, 'menuConfig.config.omitFileAreaTags', [])
        );
        const filterCriteria = {
            newerThanFileId: FileBaseFilters.getFileBaseLastViewedFileIdByUser(
                this.client.user
            ),
            areaTag: getAvailableFileAreaTags(this.client).filter(
                ft => !omitFileAreaTags.includes(ft)
            ),
            order: 'ascending', //  oldest first
        };

        FileEntry.findFiles(filterCriteria, (err, fileIds) => {
            if (err || 0 === fileIds.length) {
                return cb(err ? err : Errors.DoesNotExist('No more new files'));
            }

            FileBaseFilters.setFileBaseLastViewedFileIdForUser(
                this.client.user,
                fileIds[fileIds.length - 1]
            );

            const menuOpts = {
                extraArgs: {
                    fileList: fileIds,
                },
            };

            return this.gotoMenu(
                this.menuConfig.config.newScanFileBaseList || 'newScanFileBaseList',
                menuOpts
            );
        });
    }

    getSaveState() {
        return {
            currentStep: this.currentStep,
            currentScanAux: this.currentScanAux,
        };
    }

    restoreSavedState(savedState) {
        this.currentStep = savedState.currentStep;
        this.currentScanAux = savedState.currentScanAux;
    }

    performScanCurrentStep(cb) {
        switch (this.currentStep) {
            case Steps.MessageConfs:
                this.newScanMessageConference(() => {
                    this.currentStep = Steps.FileBase;
                    return this.performScanCurrentStep(cb);
                });
                break;

            case Steps.FileBase:
                this.newScanFileBase(() => {
                    this.currentStep = Steps.Finished;
                    this.updateScanStatus(this.scanCompleteMsg);
                    // Wait for key press before finishing
                    this.client.once('key press', () => {
                        return this.performScanCurrentStep(cb);
                    });
                });
                break;

            default:
                return cb(null);
        }
    }

    mciReady(mciData, cb) {
        if (this.newScanFullExit) {
            //  user has canceled the entire scan @ message list view
            return cb(null);
        }

        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            const self = this;
            const vc = (self.viewControllers.allViews = new ViewController({
                client: self.client,
            }));

            //  :TODO: display scan step/etc.

            async.series(
                [
                    function loadFromConfig(callback) {
                        const loadOpts = {
                            callingMenu: self,
                            mciMap: mciData.menu,
                            noInput: true,
                        };

                        vc.loadFromMenuConfig(loadOpts, callback);
                    },
                    function performCurrentStepScan(callback) {
                        return self.performScanCurrentStep(callback);
                    },
                ],
                err => {
                    if (err) {
                        self.client.log.error(
                            { error: err.toString() },
                            'Error during new scan'
                        );
                    }
                    return cb(err);
                }
            );
        });
    }
};
