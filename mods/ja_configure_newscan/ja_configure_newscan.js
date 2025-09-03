/* jslint node: true */
'use strict';

// ENiGMA½
const MenuModule = require('../../core/menu_module.js').MenuModule;
const messageArea = require('../../core/message_area.js');

// deps
const async = require('async');

// Helper to clear the status area only
function clearStatusArea(term, row = 3, col = 40, width = 35) {
    term.write(`\x1b[${row};${col}H${' '.repeat(width)}`);
}

exports.moduleInfo = {
    name: 'Configure Newscan Areas',
    desc: 'Allow users to configure which message areas are scanned by Newscan',
    author: 'YourName',
    packageName: 'com.yourname.bbs.configure-newscan',
};

exports.getModule = class ConfigureNewscanModule extends MenuModule {
    constructor(options) {
        super(options);

        this.currentIndex = 0;
        this.listHeight = 11;
        this.listWidth = 65;
        this.listStartRow = 6;
        this.listStartCol = 5;
        this.availableAreas = [];

        // Use standard menu methods pattern
        this.menuMethods = {
            done: (formData, extraArgs, cb) => {
                return this.prevMenu(cb);
            },
            selectArea: (formData, extraArgs, cb) => {
                this.toggleCurrentArea();
                return cb(null);
            },
            toggleAllAreas: (formData, extraArgs, cb) => {
                this.toggleAllAreas();
                return cb(null);
            },
            setGlobalNewscanDate: (formData, extraArgs, cb) => {
                this.setGlobalNewscanDate(formData, cb);
                return cb(null);
            }
        };
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            const self = this;

            async.series([
                function prepareViewController(callback) {
                    return self.prepViewController('main', 0, mciData.menu, callback);
                },

                function loadAreas(callback) {
                    return self.loadAvailableAreas(callback);
                },

                function setupMenuView(callback) {
                    const vm1 = self.viewControllers.main.getView(1);
                    if (!vm1) {
                        return callback(new Error('VM1 view not found'));
                    }

                    // Update area display objects
                    self.updateAreaListObjects();

                    // Set items for the vertical menu
                    vm1.setItems(self.availableAreas.map((area, index) => ({
                        text: area.text,
                        data: index
                    })));

                    vm1.setFocusItemIndex(0);

                    // Listen for navigation updates
                    vm1.on('index update', (newIndex) => {
                        self.currentIndex = newIndex;
                        self.updateStatus();
                    });

                    self.updateStatus();

                    return callback(null);
                }
            ], err => {
                if (err) {
                    self.client.log.error({ error: err.message }, 'Error loading newscan config');
                }
                return cb(err);
            });
        });
    }

    onKeyPress(ch, key) {
        // Erase the status message line (row 4, col 40) -- use precise area clearing
        clearStatusArea(this.client.term, 4, 40, 35);
        // Handle 'A' or 'a' for toggle all
        if (ch && (ch === 'A' || ch === 'a')) {
            this.toggleAllAreas();
            return;
        }
        // Pass to focused view (vertical menu)
        const vm1 = this.viewControllers.main.getView(1);
        if (vm1 && vm1.acceptsInput) {
            vm1.onKeyPress(ch, key);
        } else {
            super.onKeyPress(ch, key);
        }
    }

    toggleCurrentArea() {
        try {
            // Erase the status message line (row 4, col 40) -- use precise area clearing
            clearStatusArea(this.client.term, 4, 40, 35);
            if (this.currentIndex >= this.availableAreas.length) return;

            const area = this.availableAreas[this.currentIndex];
            let newscanTags = this.client.user.properties['NewScanMessageAreaTags'] || '';
            let areaTagsArray = newscanTags.length > 0 ? newscanTags.split(',') : [];

            const areaIndex = areaTagsArray.indexOf(area.areaTag);
            if (areaIndex === -1) {
                // Add to newscan
                areaTagsArray.push(area.areaTag);
            } else {
                // Remove from newscan
                areaTagsArray.splice(areaIndex, 1);
            }

            // Save the updated newscan tags to memory
            this.client.user.properties['NewScanMessageAreaTags'] = areaTagsArray.join(',');

            // Persist the property to database immediately
            this.client.user.persistProperty('NewScanMessageAreaTags', areaTagsArray.join(','), (err) => {
                if (err) {
                    this.client.log.error({ error: err.message }, 'Failed to persist NewScanMessageAreaTags');
                } else {
                    this.client.log.debug('NewScanMessageAreaTags persisted successfully');

                    // Invalidate newscan cache since user changed their newscan configuration
                    try {
                        const newscanModule = require('../ja_newscan/ja_newscan.js');
                        if (newscanModule && newscanModule.invalidateUserCache) {
                            newscanModule.invalidateUserCache(this.client.user.userId);
                        }
                    } catch (e) {
                        // Module might not be loaded, that's okay
                        this.client.log.debug('Could not invalidate newscan cache, module not loaded');
                    }
                }
            });

            // Update the internal data so it persists when VM1 redraws
            this.updateAreaListObjects();

            // Update VM1's internal item data
            const vm1 = this.viewControllers.main.getView(1);
            if (vm1 && vm1.items[this.currentIndex]) {
                // Update the VM1 item with the new text
                vm1.items[this.currentIndex].text = this.availableAreas[this.currentIndex].text;

                // Force VM1 to redraw just this item properly
                vm1.invalidateRenderCache();
                const item = vm1.items[this.currentIndex];
                if (item.row) {
                    // Let VM1 redraw the item with proper colors
                    vm1.drawItem(this.currentIndex);
                }
            }

            this.updateStatus();

        } catch (error) {
            this.client.log.error({ error: error.message }, 'Error in toggleCurrentArea');
        }
    }

    toggleAllAreas() {
        try {
            const allTags = this.availableAreas.map(area => area.areaTag);
            let newscanTags = this.client.user.properties['NewScanMessageAreaTags'] || '';
            let areaTagsArray = newscanTags.length > 0 ? newscanTags.split(',') : [];

            // If all selected, clear all; else, select all
            let selectAll = areaTagsArray.length !== allTags.length;
            areaTagsArray = selectAll ? allTags.slice() : [];

            // Save the updated newscan tags to memory
            this.client.user.properties['NewScanMessageAreaTags'] = areaTagsArray.join(',');

            // Persist the property to database immediately
            this.client.user.persistProperty('NewScanMessageAreaTags', areaTagsArray.join(','), (err) => {
                if (err) {
                    this.client.log.error({ error: err.message }, 'Failed to persist NewScanMessageAreaTags');
                } else {
                    this.client.log.debug('NewScanMessageAreaTags toggled for all areas');

                    // Invalidate newscan cache since user changed their newscan configuration
                    try {
                        const newscanModule = require('../ja_newscan/ja_newscan.js');
                        if (newscanModule && newscanModule.invalidateUserCache) {
                            newscanModule.invalidateUserCache(this.client.user.userId);
                        }
                    } catch (e) {
                        // Module might not be loaded, that's okay
                        this.client.log.debug('Could not invalidate newscan cache, module not loaded');
                    }
                }
            });

            // Update the internal data so it persists when VM1 redraws
            this.updateAreaListObjects();

            // Update VM1's internal item data and force redraw
            const vm1 = this.viewControllers.main.getView(1);
            if (vm1) {
                // Set new items so asterisks and text update
                vm1.setItems(this.availableAreas.map((area, index) => ({
                    text: area.text,
                    data: index
                })));
                vm1.invalidateRenderCache();
                vm1.redraw();
            }

            this.updateStatus();

            // Show a status message, up to 35 columns at col 40
            const startRow = 4;
            const startCol = 40;
            const width = 35;
            let statusMsg = `Newscan ${selectAll ? 'enabled' : 'disabled'} for all areas`;
            statusMsg = statusMsg.padEnd(width).slice(0, width);
            clearStatusArea(this.client.term, startRow, startCol, width);
            if (statusMsg.trim().length > 0) {
                this.client.term.write(`\x1b[${startRow};${startCol}H\x1b[33m${statusMsg}\x1b[0m`);
            }
        } catch (error) {
            this.client.log.error({ error: error.message }, 'Error in toggleAllAreas');
        }
    }

    setGlobalNewscanDate(formData, cb) {
        try {
            // Get the date from form data (assuming it's in a text input)
            const dateInput = formData.value.globalNewscanDate || formData.value.scanDate;
            if (!dateInput) {
                this.client.term.write('\x1b[4;40H\x1b[31mNo date provided\x1b[0m');
                return cb(null);
            }

            const moment = require('moment');
            // Try multiple date formats
            const formats = ['YYYYMMDD', 'YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY'];
            let scanDate = null;

            for (const format of formats) {
                scanDate = moment(dateInput, format, true);
                if (scanDate.isValid()) {
                    break;
                }
            }

            if (!scanDate || !scanDate.isValid()) {
                this.client.term.write('\x1b[4;40H\x1b[31mInvalid date format\x1b[0m');
                return cb(null);
            }

            // Store the global newscan date as a user property
            this.client.user.persistProperty('GlobalNewscanDate', scanDate.toISOString(), (err) => {
                if (err) {
                    this.client.log.error({ error: err.message }, 'Failed to persist GlobalNewscanDate');
                    this.client.term.write('\x1b[4;40H\x1b[31mFailed to save date\x1b[0m');
                } else {
                    this.client.log.info({
                        scanDate: scanDate.format('YYYY-MM-DD'),
                        userId: this.client.user.userId
                    }, 'Global newscan date set');

                    // Show success message
                    this.client.term.write(`\x1b[4;40H\x1b[32mGlobal newscan date set to ${scanDate.format('YYYY-MM-DD')}\x1b[0m`);

                    // Invalidate newscan cache since user changed their newscan date
                    try {
                        const newscanModule = require('../ja_newscan/ja_newscan.js');
                        if (newscanModule && newscanModule.invalidateUserCache) {
                            newscanModule.invalidateUserCache(this.client.user.userId);
                        }
                    } catch (e) {
                        // Module might not be loaded, that's okay
                        this.client.log.debug('Could not invalidate newscan cache, module not loaded');
                    }
                }
                return cb(null);
            });
        } catch (error) {
            this.client.log.error({ error: error.message }, 'Error in setGlobalNewscanDate');
            this.client.term.write('\x1b[4;40H\x1b[31mError setting date\x1b[0m');
            return cb(null);
        }
    }

    loadAvailableAreas(cb) {
        try {
            this.availableAreas = [];

            // Get available conferences
            const availableConfs = messageArea.getAvailableMessageConferences(this.client);

            Object.keys(availableConfs).forEach(confTag => {
                if (confTag === 'system_internal') {
                    return; // Skip system internal
                }

                const conf = messageArea.getMessageConferenceByTag(confTag);
                const confName = conf ? conf.name : confTag;

                // getAvailableMessageAreasByConfTag returns an OBJECT, not an array
                const areasInConf = messageArea.getAvailableMessageAreasByConfTag(confTag, {
                    client: this.client
                });

                if (areasInConf) {
                    // Iterate over the object keys (area tags)
                    Object.keys(areasInConf).forEach(areaTag => {
                        const area = areasInConf[areaTag];
                        this.availableAreas.push({
                            areaTag: areaTag,
                            confTag: confTag,
                            name: area.name || areaTag,
                            desc: area.desc || '',
                            confName: confName,
                            text: '' // Will be set in updateAreaListObjects
                        });
                    });
                }
            });

            return cb(null);
        } catch (error) {
            this.client.log.error({ error: error.message }, 'Error loading available areas');
            return cb(error);
        }
    }

    updateAreaListObjects() {
        try {
            const newscanTags = this.client.user.properties['NewScanMessageAreaTags'] || '';
            const newscanArray = newscanTags.length > 0 ? newscanTags.split(',') : [];

            // Define exact column positions and widths to match your art
            const layout = {
                indicator: { start: 0, width: 1 },
                conference: { start: 2, width: 12 },
                areaName: { start: 15, width: 48 }
            };

            this.availableAreas.forEach((area) => {
                const isSelected = newscanArray.includes(area.areaTag);

                // Create a fixed-width string buffer
                const lineLength = layout.areaName.start + layout.areaName.width;
                let line = ' '.repeat(lineLength);

                // Position each field at exact columns
                line = this.placeTextAtPosition(line, isSelected ? '*' : ' ', layout.indicator.start, layout.indicator.width);
                line = this.placeTextAtPosition(line, area.confName || area.confTag || '', layout.conference.start, layout.conference.width);
                line = this.placeTextAtPosition(line, area.name || area.areaTag, layout.areaName.start, layout.areaName.width);

                area.text = line;
            });
        } catch (error) {
            this.client.log.error({ error: error.message }, 'Error in updateAreaListObjects');
        }
    }

    // Helper to place text at exact position with truncation
    placeTextAtPosition(line, text, startPos, maxWidth) {
        if (!text) text = '';
        text = String(text);

        // Truncate with ellipsis if needed
        if (text.length > maxWidth) {
            if (maxWidth <= 3) {
                text = text.substring(0, maxWidth);
            } else {
                text = text.substring(0, maxWidth - 3) + '...';
            }
        }

        // Replace characters in the line at the specified position
        const lineArray = line.split('');
        for (let i = 0; i < text.length && startPos + i < lineArray.length; i++) {
            lineArray[startPos + i] = text[i];
        }

        return lineArray.join('');
    }

    updateStatus() {
        try {
            const newscanTags = this.client.user.properties['NewScanMessageAreaTags'] || '';
            const newscanArray = newscanTags.length > 0 ? newscanTags.split(',') : [];

            // Update status in top area (single line only), up to 35 columns at col 40
            const startRow = 3;
            const startCol = 40;
            const width = 35;
            let statusMsg = `Selected ${newscanArray.length} of ${this.availableAreas.length} areas for newscan`;
            statusMsg = statusMsg.padEnd(width).slice(0, width);

            // Clear only the status area, then write the message (no \x1b[K)
            clearStatusArea(this.client.term, startRow, startCol, width);
            if (statusMsg.trim().length > 0) {
                this.client.term.write(`\x1b[${startRow};${startCol}H\x1b[32m${statusMsg}\x1b[0m`);
            }

            // Show global newscan date if set
            const globalNewscanDate = this.client.user.properties['GlobalNewscanDate'];
            if (globalNewscanDate) {
                const moment = require('moment');
                const dateMoment = moment(globalNewscanDate);
                if (dateMoment.isValid()) {
                    const dateRow = 2;
                    const dateMsg = `Global newscan date: ${dateMoment.format('YYYY-MM-DD')}`;
                    clearStatusArea(this.client.term, dateRow, startCol, width);
                    this.client.term.write(`\x1b[${dateRow};${startCol}H\x1b[36m${dateMsg.padEnd(width).slice(0, width)}\x1b[0m`);
                }
            }
        } catch (error) {
            this.client.log.error({ error: error.message }, 'Error in updateStatus');
        }
    }

    // Proper cleanup following Enigma patterns
    leave() {
        try {
            // Clear any display artifacts and reset cursor/colors
            const ansi = require('../../core/ansi_term.js');

            // Reset all graphics rendition and clear any lingering colors/styles
            this.client.term.rawWrite(ansi.normal());

            // Clear any potential scroll regions or other terminal state issues
            this.client.term.rawWrite('\x1b[r'); // Reset scroll region
            this.client.term.rawWrite('\x1b[?25h'); // Show cursor

        } catch (error) {
            this.client.log.error({ error: error.message }, 'Error in leave');
        }

        // Call parent leave method which will handle screen reset if cls is configured
        super.leave();
    }

    // Add finishedLoading method like other Enigma modules
    finishedLoading() {
        // Focus the vertical menu view
        const vm1 = this.viewControllers.main.getView(1);
        if (vm1) {
            vm1.setFocus(true);
        }
    }
};