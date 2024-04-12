import {
    exportToCsv,
    ListStorage,
    UIContainer,
    createCta,
    createSpacer,
    createTextSpan,
    HistoryTracker,
    LogCategory
} from 'browser-scraping-utils';

interface WhatsAppMember {
    profileId: string
    name?: string
    description?: string
    phoneNumber?: string
    source?: string
}


function cleanName(name: string): string{
    const nameClean = name.trim()
    return nameClean.replace('~ ', '')
}

function cleanDescription(description: string) : string | null {
    const descriptionClean = description.trim()
    if(
        !descriptionClean.match(/Loading About/i) &&
        !descriptionClean.match(/I am using WhatsApp/i) &&
        !descriptionClean.match(/Available/i)
    ){
        return descriptionClean
    }
    return null;
}


class WhatsAppStorage extends ListStorage<WhatsAppMember> {
    get headers() {
        return [
            'Phone Number',
            'Name',
            'Description',
            'Source'
        ]
    }
    itemToRow(item: WhatsAppMember): string[]{
        return [
            item.phoneNumber ? item.phoneNumber : "",
            item.name ? item.name : "",
            item.description ? item.description : "",
            item.source ? item.source : ""
        ]
    }
}

const memberListStore = new WhatsAppStorage({
    name: "whatsapp-scraper"
});
const counterId = 'scraper-number-tracker'
const exportName = 'whatsAppExport';
let logsTracker: HistoryTracker;

async function updateConter(){
    // Update member tracker counter
    const tracker = document.getElementById(counterId)
    if(tracker){
        const countValue = await memberListStore.getCount();
        tracker.textContent = countValue.toString()
    }
}

const uiWidget = new UIContainer();

function buildCTABtns(){
    // History Tracker
    logsTracker = new HistoryTracker({
        onDelete: async (groupId: string) => {
            // We dont have cancellable adds for now
            console.log(`Delete ${groupId}`);
            await memberListStore.deleteFromGroupId(groupId);
            await updateConter();
        },
        divContainer: uiWidget.history,
        maxLogs: 4
    })

    // Button Download
    const btnDownload = createCta();
    btnDownload.appendChild(createTextSpan('Download\u00A0'))
    btnDownload.appendChild(createTextSpan('0', {
        bold: true,
        idAttribute: counterId
    }))
    btnDownload.appendChild(createTextSpan('\u00A0users'))

    btnDownload.addEventListener('click', async function() {
        const timestamp = new Date().toISOString()
        const data = await memberListStore.toCsvData()
        try{
            exportToCsv(`${exportName}-${timestamp}.csv`, data)
        }catch(err){
            console.error('Error while generating export');
            // @ts-ignore
            console.log(err.stack)
        }
    });

    uiWidget.addCta(btnDownload)

    // Spacer
    uiWidget.addCta(createSpacer())

    // Button Reinit
    const btnReinit = createCta();
    btnReinit.appendChild(createTextSpan('Reset'))
    btnReinit.addEventListener('click', async function() {
        await memberListStore.clear();
        logsTracker.cleanLogs();
        await updateConter();
    });
    uiWidget.addCta(btnReinit);

    // Draggable
    uiWidget.makeItDraggable();

    // Render
    uiWidget.render()

    // Initial
    window.setTimeout(()=>{
        updateConter()
    }, 1000)
}

let modalObserver: MutationObserver;

function listenModalChanges(){
    const groupNameNode = document.querySelectorAll("header span[style*='height']:not(.copyable-text)")
    let source: string | null;
    if(groupNameNode.length==1){
        source = groupNameNode[0].textContent
    }
    const modalElems = document.querySelectorAll('[data-animate-modal-body="true"]');

    const modalElem = modalElems[0]
    const targetNode = modalElem.querySelectorAll("div[style*='height']")[1];
    
    const config = { attributes: true, childList: true, subtree: true };
    
    // Callback function to execute when mutations are observed
    const callback = (
        mutationList: MutationRecord[],
        // observer: MutationObserver
    ) => {
        for (const mutation of mutationList) {
            if (mutation.type === "childList") {
                // console.log("A child node has been added or removed.");
                if(mutation.addedNodes.length>0){
                    const node = mutation.addedNodes[0]
                    const text = node.textContent;
                    if(text){
                        const textClean = text.trim();
                        if(textClean.length>0){
                            if(
                                !textClean.match(/Loading About/i) &&
                                !textClean.match(/I am using WhatsApp/i) &&
                                !textClean.match(/Available/i)
                            ){
                                // console.log(text)
                            }
                        }
                    }
                }
            }else if (mutation.type === "attributes") {
                const target = mutation.target as HTMLElement;
                const tagName = target.tagName;
    
                // Must be a div with role="listitem"
                if(
                    ['div'].indexOf(tagName.toLowerCase())===-1 ||
                    target.getAttribute("role")!=="listitem"
                ){
                    continue;
                }
    
                const listItem = target;
    
                // Use timeout to way for all data to be displayed
                window.setTimeout(async ()=>{
                    let profileName = "";
                    let profileDescription = "";
                    let profilePhone = ""
                    
                    // Name
                    const titleElems = listItem.querySelectorAll("span[title]:not(.copyable-text)");
                    if(titleElems.length>0){
                        const text = titleElems[0].textContent
                        if(text){
                            const name = cleanName(text);
                            if(name && name.length>0){
                                profileName = name;
                            }
                        }
                    }
    
                    if(profileName.length===0){
                        return;
                    }
    
                    // Description
                    const descriptionElems = listItem.querySelectorAll("span[title].copyable-text");
        
                    if(descriptionElems.length>0){
                        const text = descriptionElems[0].textContent;
                        if(text){
                            const description = cleanDescription(text);
                            if(description && description.length>0){
                                profileDescription = description;
                            }
                        }
                    }
    
                    // Phone
                    const phoneElems = listItem.querySelectorAll("span[style*='height']:not([title])");
                    if(phoneElems.length>0){
                        const text = phoneElems[0].textContent;
                        if(text){
                            const textClean = text.trim()
                            
                            if(textClean && textClean.length>0){
                                profilePhone = textClean;
                            }
                        }
                    }
                    
    
                    if(profileName){
                        const identifier = profilePhone ? profilePhone : profileName;
                        console.log(identifier)

                        const data: {
                            name?: string,
                            description?: string,
                            phoneNumber?: string,
                            source?: string
                        } = {
                        }

                        if(source){
                            data.source = source;
                        }

                        if(profileDescription){
                            data.description = profileDescription
                        }
                        if(profilePhone){
                            data.phoneNumber = profilePhone;
                            if(profileName){
                                data.name = profileName
                            }
                        }else{
                            if(profileName){
                                data.phoneNumber = profileName;
                            }
                        }

                        await memberListStore.addElem(
                            identifier, {
                                profileId: identifier,
                                ...data
                            },
                            true // Update
                        )
        
                        let profileStr = profileName;
                        if(profilePhone){
                            profileStr += ` - ${profilePhone}`
                        }
                        if(profileDescription){
                            profileStr += ` - ${profileDescription}`
                        }
                        
                        logsTracker.addHistoryLog({
                            label: `Scraping ${profileName}`,
                            category: LogCategory.LOG
                        })

                        updateConter()
                    }    
                }, 10)
            }
        }
    };
    
    // Create an observer instance linked to the callback function
    modalObserver = new MutationObserver(callback);
    
    // Start observing the target node for configured mutations
    modalObserver.observe(targetNode, config);
}

function stopListeningModalChanges(){
    // Later, you can stop observing
    if(modalObserver){
        modalObserver.disconnect();
    }
}


function main(): void {
    buildCTABtns();


    logsTracker.addHistoryLog({
        label: "Wait for modal",
        category: LogCategory.LOG
    })

    function bodyCallback(
        mutationList: MutationRecord[],
        // observer: MutationObserver
    ){
        for (const mutation of mutationList) {
            // console.log(mutation)
            if (mutation.type === "childList") {
                if(mutation.addedNodes.length>0){
                    mutation.addedNodes.forEach((node)=>{
                        const htmlNode = node as HTMLElement
                        const modalElems = htmlNode.querySelectorAll('[data-animate-modal-body="true"]');
                        if(modalElems.length>0){
                            window.setTimeout(()=>{
                                listenModalChanges();
    
                                logsTracker.addHistoryLog({
                                    label: "Modal found - Scroll to scrape",
                                    category: LogCategory.LOG
                                })
                            }, 10)
                        }
                    })
                }
                if(mutation.removedNodes.length>0){
                    mutation.removedNodes.forEach((node)=>{
                        const htmlNode = node as HTMLElement
                        const modalElems = htmlNode.querySelectorAll('[data-animate-modal-body="true"]');
                        if(modalElems.length>0){
                            stopListeningModalChanges();
                            logsTracker.addHistoryLog({
                                label: "Modal Removed - Scraping Stopped",
                                category: LogCategory.LOG
                            })
                        }
                    })
                }
            }
        }
    }
    
    const bodyConfig = { attributes: true, childList: true, subtree: true };
    const bodyObserver = new MutationObserver(bodyCallback);
    
    // Start observing the target node for configured mutations
    const app = document.getElementById('app');
    if(app){
        bodyObserver.observe(app, bodyConfig);
    }    
}

main();
