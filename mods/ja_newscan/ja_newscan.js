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
const msgDb = require('../../core/database.js').dbs.message;

//  deps
const _ = require('lodash');
const async = require('async');

// Performance optimization cache for newscan
const newscanCache = {
    batchResults: new Map(),        // userId -> {results, timestamp}
    areaAccess: new Map(),          // userId_areaTag -> boolean
    cacheTimeout: 30000,            // 30 seconds

    // Clear expired cache entries
    cleanup() {
        const now = Date.now();
        for (const [key, value] of this.batchResults.entries()) {
            if (now - value.timestamp > this.cacheTimeout) {
                this.batchResults.delete(key);
            }
        }
    },

    // Get cached batch results if still valid
    getBatchResults(userId) {
        this.cleanup();
        const cached = this.batchResults.get(userId);
        if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
            return cached.results;
        }
        return null;
    },

    // Cache batch results
    setBatchResults(userId, results) {
        this.batchResults.set(userId, {
            results: results,
            timestamp: Date.now()
        });
    }
};

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
        // Clear the status area first by padding with spaces
        const clearLine = ' '.repeat(80); // Use a reasonable line width
        this.setViewText('allViews', MciCodeIds.ScanStatusLabel, clearLine);
        this.setViewText('allViews', MciCodeIds.ScanStatusList, clearLine);
        // Then set the new status
        this.setViewText('allViews', MciCodeIds.ScanStatusLabel, statusText);
    }

    // Optimized batch function to get new message counts for multiple areas at once
    // This replaces the N+1 query problem with a single efficient query
    getBatchNewMessageCountsForUser(userId, areaTags, cb) {
        if (!Array.isArray(areaTags) || areaTags.length === 0) {
            return cb(null, {});
        }

        // Check cache first
        const cached = newscanCache.getBatchResults(userId);
        if (cached) {
            // Filter cached results to only requested areas
            const filteredResults = {};
            areaTags.forEach(areaTag => {
                if (cached[areaTag]) {
                    filteredResults[areaTag] = cached[areaTag];
                }
            });
            if (Object.keys(filteredResults).length === areaTags.length) {
                return cb(null, filteredResults);
            }
        }

        // Build the optimized batch query using a simpler approach for SQLite
        const placeholders = areaTags.map(() => '?').join(',');

        const query = `
            SELECT
                m.area_tag,
                COALESCE(lr.message_id, 0) as last_read_id,
                COUNT(CASE WHEN m.message_id > COALESCE(lr.message_id, 0) THEN 1 END) as new_count
            FROM (
                SELECT DISTINCT area_tag FROM message WHERE area_tag IN (${placeholders})
            ) areas
            LEFT JOIN message m ON areas.area_tag = m.area_tag
            LEFT JOIN user_message_area_last_read lr
                ON LOWER(areas.area_tag) = LOWER(lr.area_tag)
                AND lr.user_id = ?
            GROUP BY areas.area_tag, lr.message_id
            ORDER BY areas.area_tag;
        `;

        const params = [...areaTags, userId];

        msgDb.all(query, params, (err, rows) => {
            if (err) {
                this.client.log.warn({ error: err.message }, 'Batch query failed, falling back to individual queries');
                // Fallback to individual queries if batch fails
                return this.fallbackToIndividualQueries(userId, areaTags, cb);
            }

            // Convert results to a map for easy lookup
            const results = {};
            rows.forEach(row => {
                results[row.area_tag] = {
                    lastReadId: row.last_read_id,
                    newCount: row.new_count || 0
                };
            });

            // Ensure all requested areas are in the results
            areaTags.forEach(areaTag => {
                if (!results[areaTag]) {
                    results[areaTag] = {
                        lastReadId: 0,
                        newCount: 0
                    };
                }
            });

            // Cache the results
            newscanCache.setBatchResults(userId, results);

            return cb(null, results);
        });
    }

    // Fallback method using individual queries (original behavior)
    fallbackToIndividualQueries(userId, areaTags, cb) {
        const results = {};

        async.eachLimit(areaTags, 3, (areaTag, nextArea) => {
            msgArea.getNewMessageCountInAreaForUser(userId, areaTag, (err, count) => {
                if (!err) {
                    results[areaTag] = {
                        lastReadId: 0, // We don't get this from individual queries
                        newCount: count || 0
                    };
                }
                return nextArea(); // Continue even if one area fails
            });
        }, (err) => {
            return cb(null, results);
        });
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

            this.client.log.debug(
                {
                    confTag: conf.confTag,
                    selectedCount: sortedAreas.length,
                    totalSelected: selectedAreaTags.length
                },
                'Filtering newscan to user-selected areas'
            );
        }

        // OPTIMIZATION: Use batch processing instead of sequential scanning
        const self = this;

        // Extract area tags for batch query
        const areaTagsToScan = sortedAreas.map(area => area.areaTag);

        if (areaTagsToScan.length === 0) {
            self.updateScanStatus(self.scanCompleteMsg);
            return cb(Errors.DoesNotExist('No areas to scan'));
        }

        // Show initial progress
        self.updateScanStatus(`Scanning ${areaTagsToScan.length} areas in ${conf.conf.name}...`);

        // Use optimized batch query
        this.getBatchNewMessageCountsForUser(
            this.client.user.userId,
            areaTagsToScan,
            (err, batchResults) => {
                if (err) {
                    self.client.log.error({ error: err.message }, 'Batch scan failed');
                    return cb(err);
                }

                // Find first area with new messages
                let foundArea = null;
                let foundCount = 0;

                for (const area of sortedAreas) {
                    const result = batchResults[area.areaTag];
                    if (result && result.newCount > 0) {
                        foundArea = area;
                        foundCount = result.newCount;
                        break;
                    }
                }

                if (foundArea) {
                    // Show what we found and launch message list
                    self.updateScanStatus(
                        stringFormat(self.scanFinishNewFmt, {
                            count: foundCount,
                            confName: conf.conf.name,
                            areaName: foundArea.area.name
                        })
                    );

                    const nextModuleOpts = {
                        extraArgs: {
                            messageAreaTag: foundArea.areaTag,
                        },
                    };

                    return self.gotoMenu(
                        self.menuConfig.config.messageListMenu || 'newScanMessageList',
                        nextModuleOpts
                    );
                } else {
                    // No messages found in any area
                    const totalAreas = sortedAreas.length;
                    self.updateScanStatus(
                        `No new messages in ${totalAreas} area${totalAreas !== 1 ? 's' : ''} in ${conf.conf.name}`
                    );

                    // Brief pause for user feedback, then continue
                    setTimeout(() => {
                        return cb(Errors.DoesNotExist('No more areas'));
                    }, 500); // Reduced from multiple 100ms delays to single 500ms
                }
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
