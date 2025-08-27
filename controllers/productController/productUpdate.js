import path from 'path';
import { chunkArray, collectionUpdate, deleteFile, deleteProductAPI, findDuplicates, getAllPublications, handleize, loginAPI, logRecordToFile, logRecordToFileNoLimit, publishablePublish, readRecordFromFile, shopifyFetch, store_data, updateMetafields } from "../../helpers/index.js";
import {
  getProductList,
  updateProductVariant
} from "../../services/index.js";

// update all products json_documents and json_spare_parts metafields: ex storeName: DIAMOND
export const updateAllProductFileMetafiels = async (storeName) => {
//using store's account to login API
  const access_token = await loginAPI({
    email: process.env[`${storeName}_EMAIL`],
    password: process.env[`${storeName}_PASSWORD`],
    store: storeName
  });

  console.log(`Getting All Products from ${storeName}.....`);
  
  //get Product List updated in the last 1 hour
  const product_list = await getProductList({
    store: storeName,
    access_token,
    action: "migrate"
  });

  console.log(`Updating All Product Metafields from ${storeName}.....`);

  if(product_list.data.length > 0){
    var metafields = [];
    const products_with_file = product_list.data.filter(product=>product.attributes.media.documents.length > 0 || product.attributes.media["spare-parts"].length > 0);
    
    const product_skus_with_file = products_with_file.map(product=>product.id);
    if(product_skus_with_file.length > 0){
      const product_skus_with_file_batches = chunkArray(product_skus_with_file, 150);
      var shopify_products = [];
      var done = 0;

      for (const product_skus_with_file_batch of product_skus_with_file_batches) {
        const get_products_query = `
          query getProducts {
            products(first: 250, query: "${product_skus_with_file_batch.map(sku=>`sku:${sku}`).join(" OR ")}") {
              nodes {
                id
                variants(first: 1){
                  nodes {
                    sku
                  }
                }
              }
            }
          }
        `;

        const result = await shopifyFetch({ query: get_products_query, store: storeName });
        const products = result.products.nodes;

        done+=product_skus_with_file_batch.length;
        console.log(`${done}/${product_skus_with_file.length} products queried!`);

        if(products.length > 0)shopify_products = shopify_products.concat(products);
      };

      if(shopify_products.length > 0){
        products_with_file.forEach(product=>{
          const found_shopify_product = shopify_products.find(shopify_product=>shopify_product.variants.nodes[0].sku == product.id);
          if(product.attributes.media.documents.length > 0){
            metafields.push({
              ownerId: found_shopify_product.id,
              namespace: "product",
              key: "json_documents",
              type: "json",
              value: JSON.stringify(product.attributes.media.documents)
            });
          };
          if(product.attributes.media["spare-parts"].length > 0){
            metafields.push({
              ownerId: found_shopify_product.id,
              namespace: "product",
              key: "json_spare_parts",
              type: "json",
              value: JSON.stringify(product.attributes.media["spare-parts"])
            });
          }
        });

        console.log("metafields", metafields.length);

        if(metafields.length > 0){
          var done = 0;
          const metafield_batches = chunkArray(metafields, 25);

          console.log(`*****  Updating All Product metafields.....  *****`);
          
          for (const metafield_batch of metafield_batches) {
            const result = await updateMetafields({ metafields: metafield_batch, store: storeName });

            done+=metafield_batch.length;
            if(result.status == "success"){
              console.log(`***** ${done}/${metafields.length} metafields updated! *****`);
            } else {
              console.log(`updating metafields failed!`, metafield_batch);
            }
          };

          console.log(`*****  All Product metafields updated!  *****`);
        }
      }
    }
  };
};

//delete all thumb, thumb-gallery and full product images: ex storeName: DIAMOND
export const deleteProductImages = async (storeName) => {
  //step 1: get all images suitable for delete
  var delete_images = [];
  var done = 0;
  var endCursor = null;
  var hasNextPage = true;
  
  console.log(`*****  Getting All Product Images need to be deleted.....  ******`);
  
  while (hasNextPage) {
    const get_image_query = `
      query MyQuery {
        files(first: 250, query: "media_type:IMAGE"${ endCursor ? `, after: "${endCursor}"` : `` }) {
          pageInfo {
            endCursor
            hasNextPage
          }
          nodes {
            id
            ... on MediaImage {
              image {
                url
              }
            }
          }
        }
      }
    `;

    const result = await shopifyFetch({ query: get_image_query, store: storeName });
    const images = result.files.nodes;

    //filter queried images to get images need to be deleted
    images.forEach(({ id, image })=>{
      if(image.url.includes("-thumb_") || image.url.includes("-thumb-gallery_"))delete_images.push(id);
    });

    done += images.length;
    console.log(`*****  ${done} images queried! *****`);
    console.log(`*****  ${delete_images.length} delete images found! *****`);
    
    if(result.files.pageInfo.hasNextPage){
      endCursor = result.files.pageInfo.endCursor;
    } else {
      hasNextPage = false;
    };
  };

  console.log(`*****  Deleting All Product Images need to be deleted.....  ******`);

  //step 2: delete all images in delete_images
  if(delete_images.length > 0){
    const delete_image_batches = chunkArray(delete_images, 50);
    var deleted = 0;
    
    for (const delete_image_batch of delete_image_batches) {
      const mutation = `
        mutation fileDelete($fileIds: [ID!]!) {
          fileDelete(fileIds: $fileIds) {
            deletedFileIds
            userErrors {
              field
              message
              code
            }
          }
        }
      `;

      const variables = {
        fileIds: delete_image_batch
      };

      const delete_result = await shopifyFetch({ query: mutation, variables, store: storeName });
      const deletedIds = delete_result.fileDelete.deletedFileIds;

      deleted+=deletedIds.length;
      console.log(`*****  ${deleted}/${delete_images.length} images deleted!  *****`);
    };
  };

  console.log(`*****  All Product Images Deleted!  ******`);
};

//create store's collections: ex storeName: DIAMOND
export const createStoreCollections = async (storeName) => {
  try {
    let product_menu = store_data[storeName]?.product_menu;

    if(!product_menu)return;

    const collections = [];
    var created_collections = [];


    for (const product_range_name of Object.keys(product_menu)) {
      const product_range = product_menu[product_range_name];
      for (const product_subrange_name of product_range) {
        collections.push({
          product_range_name,
          product_subrange_name
        });
      }
    }

    if(collections.length > 0){
      const collection_batches = chunkArray(collections, 5);
      var done = 0;

      console.log(`*****  Creating collections for ${storeName}.....  *****`);

      for (const collection_batch of collection_batches) {
        const create_collection_result = await Promise.all(collection_batch.map(({product_range_name, product_subrange_name})=>{
          const input = {
            title: `${product_range_name}_${product_subrange_name}`,
            ruleSet: {
              appliedDisjunctively: false,
              rules: [
                {
                  column: "PRODUCT_METAFIELD_DEFINITION",
                  conditionObjectId: "gid://shopify/MetafieldDefinition/288024002892",
                  relation: "EQUALS",
                  condition: product_range_name
                },
                {
                  column: "PRODUCT_METAFIELD_DEFINITION",
                  conditionObjectId: "gid://shopify/MetafieldDefinition/288024068428",
                  relation: "EQUALS",
                  condition: product_subrange_name
                }
              ]
            }
          };

          return createCollection({ input, store: storeName });
        })).then(values=>values);
        
        if(create_collection_result.filter(result=>result.userErrors.length != 0).length > 0)throw create_collection_result.filter(result=>result.userErrors.length != 0).map(result=>result.userErrors).flat();

        done += create_collection_result.filter(result=>result.userErrors.length == 0).length;
        console.log(`*****  ${done}/${collections.length} collections created!  *****`);

        created_collections = created_collections.concat(create_collection_result.filter(result=>result.userErrors.length == 0).map(result=>{
          return {
            id: result.collection.id,
            title: result.collection.title,
            handle: result.collection.handle
          }
        }))
      };

      console.log(`*****  All collections created for ${storeName}!  *****`);

      if(created_collections.length > 0){
        const filePath = path.resolve(process.cwd(), 'logs', `created_collections.json`);
        logRecordToFile({ records: created_collections, filePath });

        console.log(`Getting All Publications from ${storeName}.....`);

        //get all publications
        const get_publication_result = await getAllPublications({
          store: storeName
        });
        const publications = get_publication_result.publications.nodes
        
        if(publications.length == 0)throw "There are no publications";


        console.log(`*****  Publishing all collections for ${storeName}.....  *****`);

        //publish collections to all channels available
        const publication_records = created_collections.map(collection=>{
          return publications.map(publication=>{
            return { id: collection.id, publication }
          });
        }).flat();
        const publication_record_batches = chunkArray(publication_records, 25);
        var done = 0;
        var publication_errors = [];
    
        for (const publication_record_batch of publication_record_batches) {
          const publish_product_errors = await Promise.all(publication_record_batch.map(record=>
            publishablePublish({ id: record.id, publication: record.publication, store: storeName })
          )).then(values=>values.map(value=>value.publishablePublish.userErrors));

          done+=publication_record_batch.length;
          console.log(`*****  ${done}/${publication_records.length} publications made!  *****`);
    
          publication_errors = publication_errors.concat(publish_product_errors.flat());
          if(publication_errors.length > 0)throw publication_errors;

          await new Promise(resolve => setTimeout(resolve, 3000));
        };
        
        console.log(`*****  All collections created and published for ${storeName}!  *****`);
      }
    }
  } catch (error) {
    console.log("error creating collections", error);
  }
};

export const createCollection = async ({ input, store }) => {
  const mutation = `
    mutation CollectionCreate($input: CollectionInput!) {
      collectionCreate(input: $input) {
        userErrors {
          field
          message
        }
        collection {
          id
          title
          handle
        }
      }
    }
  `;

  const variables = {
    input
  };

  const result = await shopifyFetch({ query: mutation, variables, store });
  return result.collectionCreate;
};

//create store's menu after the collections: ex storeName: DIAMOND
export const createStoreMenu = async (storeName) => {
  let product_menu = store_data[storeName]?.product_menu;

  if(!product_menu)return;

  const filePath = path.resolve(process.cwd(), 'logs', `created_collections.json`);
  const collections = readRecordFromFile({ filePath });

  if(!collections)return;

  const mutation = `
    mutation CreateMenu($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
      menuCreate(title: $title, handle: $handle, items: $items) {
        menu {
          id
          handle
          items {
            id
            title
            items {
              id
              title
            }
          }
        }
      }
    }
  `;

  const variables = {
    title: "Produkte",
    handle: "produkte",
    items: Object.keys(product_menu).map(product_range_name=>{
      const product_range = product_menu[product_range_name];
      return {
        title: product_range_name,
        type: "FRONTPAGE",
        items: product_range.map(product_subrange_name=>{
          return {
            title: product_subrange_name,
            resourceId: collections.find(collection=>collection.title == `${product_range_name}_${product_subrange_name}`)?.id,
            type: "COLLECTION",
          }
        })
      }
    })
  };

  const result = await shopifyFetch({ query: mutation, variables, store:storeName })

  if(result.menuCreate?.menu?.id)console.log(`*****  Menu ${result.menuCreate.menu.handle} created!  *****`);
};

//check if there are any missing products after migrating (get all product ids from store (DIAMOND, etc) and query for their Shopify version, rule out the missing ones)
export const checkForMissingProducts = async (storeName) => {
  //using store's account to login API
  const access_token = await loginAPI({
    email: process.env[`${storeName}_EMAIL`],
    password: process.env[`${storeName}_PASSWORD`],
    store: storeName
  });

  console.log(`*****  Getting all products from ${storeName}.....  *****`);

  //get all Products
  const product_list = await getProductList({
    store: storeName,
    access_token,
    action: "migrate"
  });

  if(product_list.data.length > 0){
    console.log(`*****  Saving all product  from ${storeName}.....  *****`);

    const filePath = path.resolve(process.cwd(), 'logs', `all_diamond_product_ids.json`);
    const product_ids = product_list.data.map(p=>p.id);
    logRecordToFile({ records: product_ids, filePath });
  }

  var file_number = 1;
  var missing_product_number = 0;
  const filePath = path.resolve(process.cwd(), 'logs', `all_diamond_product_ids.json`);
  const product_ids = await readRecordFromFile({ filePath });
  var done = 0;
  console.log(product_ids.length);

  const product_id_batches = chunkArray(product_ids, 100);
  
  console.log(`*****  Getting Diamond Products from Shopify.....  *****`);

  for (const product_id_batch of product_id_batches) {
    // Get all Diamond-updated Products from Shopify by Diamond ID
    const diamond_product_skus = product_id_batch.map(product_id=>`sku:${product_id}`).join(" OR ");

    const get_products_by_sku_query = `
      query getProducts {
        products(first: 250, query: "${diamond_product_skus}") {
          nodes {
            id
            title
            status
            variants(first: 1) {
              nodes {
                sku
              }
            }
          }
        }
      }
    `;

    const result = await shopifyFetch({ query: get_products_by_sku_query, store: storeName });
    const shopify_products = result.products.nodes;

    // Check if there are newly-created Diamond Product to sync to Shopify (is_old == false and not exist in Shopify)
    const diamond_product_ids_in_shopify = shopify_products.map(product=>product.variants.nodes[0].sku);

    const batch_newly_created_diamond_products = product_id_batch.filter(product_id=>!diamond_product_ids_in_shopify.includes(product_id));
    done+=product_id_batch.length;
    console.log(`*****  ${done}/${product_ids.length} products queried!  *****`);

    if(batch_newly_created_diamond_products.length > 0){
      missing_product_number+=batch_newly_created_diamond_products.length;
      const filePath = path.resolve(process.cwd(), 'logs', `missing_diamond_product_ids_${file_number}.json`);
      file_number = logRecordToFile({ records: batch_newly_created_diamond_products, filePath });
    }
  };

  console.log(`*****  All products queried! Missing ${missing_product_number} products  *****`);
};

//update all product prices follow the new price logic: ex storeName: DIAMOND
export const updateAllProductPrices = async (storeName) => {
  try {
    //using store's account to login API
    const access_token = await loginAPI({
      email: process.env[`${storeName}_EMAIL`],
      password: process.env[`${storeName}_PASSWORD`],
      store: storeName
    });

    console.log(`*****  Getting all products from ${storeName}.....  *****`);

    //get all Products
    const product_list = await getProductList({
      store: storeName,
      access_token,
      action: "migrate"
    });

    if(product_list.data.length > 0){
      console.log(`*****  Updating all product prices from ${storeName}.....  *****`);

      var done = 0;

      const product_batches = chunkArray(product_list.data, 10);

      for (const product_batch of product_batches) {
        // Get all Diamond Products from Shopify by Diamond ID
        const diamond_product_skus = product_batch.map(product=>`sku:${product.id}`).join(" OR ");

        const get_products_by_sku_query = `
          query getProducts {
            products(first: 250, query: "${diamond_product_skus}") {
              nodes {
                id
                variants(first: 1) {
                  nodes {
                    id
                    sku
                  }
                }
              }
            }
          }
        `;

        const result = await shopifyFetch({ query: get_products_by_sku_query, store: storeName });
        const shopify_products = result.products.nodes;

        const update_price_result = await Promise.all(product_batch.map(productData=>{
          const shopify_product = shopify_products.find(shopify_product=>shopify_product.variants.nodes[0].sku == productData.id);
          return updateProductVariant({ 
            productData,
            store: storeName,
            productId: shopify_product.id,
            variantId: shopify_product.variants.nodes[0].id
          })
        })).then(values=>{return values.map(result=>result.productVariantsBulkUpdate.userErrors).flat()});
    
        if(update_price_result.length > 0)throw update_price_result;

        done+=product_batch.length;
        console.log(`*****  ${done}/${product_list.data.length} products Updated!  *****`);
      };
    };

    console.log(`*****  All product prices updated!  *****`);
  } catch (error) {
    console.log("Error updating product prices!", error);
  }
};

//check if there are any duplicate products after migrating (get all product ids from Shopify store (DIAMOND, etc) then save them, rule out the duplicates)
export const checkForDuplicateProducts = async (storeName) => {
  //get all products and save them in a file
  var endCursor = "";
  var hasNextPage = true;
  var queried_number = 0;

  console.log(`Querying Products.....`);

  const filePath = path.resolve(process.cwd(), 'logs', `created_products.json`);
  while (hasNextPage) {
    const query = `
      query GetProducts {
        products(first: 200${endCursor != "" ? `, after: "${endCursor}"` : ""}) {
          nodes {
            id
            variants(first: 1){
              nodes {
                sku
              }
            }
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    `;

    const result = await shopifyFetch({ query, store: storeName });
    const product_skus = result?.products?.nodes.map(product=>product.variants.nodes[0].sku);

    endCursor = result.products.pageInfo.endCursor;
    hasNextPage = result.products.pageInfo.hasNextPage;

    if(product_skus && product_skus.length > 0){
      queried_number+=product_skus.length;
      console.log(`${queried_number} products queried!`);

      logRecordToFileNoLimit({ records: product_skus, filePath });
    }
  }

  console.log(`All products queried!`);

  //read from the created file and filter out duplicates
  const data = readRecordFromFile({ filePath });
  console.log("sku duplicates", findDuplicates(data.filter(i=>i)));

  //delete file when its done
  await deleteFile({ filePath });
};

//delete products conditionally
export const deleteProducts = async (storeName) => {
  //get all products and save them in a file
  var endCursor = "";
  var hasNextPage = true;
  var queried_number = 0;

  console.log(`Querying Products.....`);

  const filePath = path.resolve(process.cwd(), 'logs', `created_products.json`);
  while (hasNextPage) {
    const query = `
      query GetProducts {
        products(first: 200${endCursor != "" ? `, after: "${endCursor}"` : ""}) {
          nodes {
            id
            variants(first: 1){
              nodes {
                sku
              }
            }
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    `;

    const result = await shopifyFetch({ query, store: storeName });
    const product_skus = result?.products?.nodes.map(product=>product.variants.nodes[0].sku);

    endCursor = result.products.pageInfo.endCursor;
    hasNextPage = result.products.pageInfo.hasNextPage;

    if(product_skus && product_skus.length > 0){
      queried_number+=product_skus.length;
      console.log(`${queried_number} products queried!`);

      logRecordToFileNoLimit({ records: product_skus, filePath });
    }
  }

  console.log(`All products queried!`);

  //read from the created file and filter out qualified skus
  const data = readRecordFromFile({ filePath });
  const skus = data.filter(i=>i);

  //filter out skus ends with LIQ or 2EME
  const delete_skus = skus.filter(sku=>sku.endsWith("LIQ") || sku.endsWith("2EME"));

  if(delete_skus.length > 0){
    //get all product ids
    const delete_sku_batches = chunkArray(delete_skus, 100);
    var found_product_ids = [];

    console.log("delete_skus", delete_skus.length);

    for (const delete_sku_batch of delete_sku_batches) {
      const shopify_product_skus = delete_sku_batch.map(sku=>`sku:${sku}`).join(" OR ");

      const query = `
        query GetProducts {
          products(first: 250, query: "${shopify_product_skus}") {
            nodes {
              id
              variants(first: 1) {
                nodes {
                  sku
                }
              }
            }
          }
        }
      `;

      const result = await shopifyFetch({ query, store: storeName });
      const products = result?.products?.nodes;
      if(products){
        const batch_found_products = delete_sku_batch.map((sku)=>products.find(product=>product.variants.nodes[0].sku == sku)?.id).filter(i=>i);
        found_product_ids = found_product_ids.concat(batch_found_products);
      }
    };

    console.log("found_product_ids", found_product_ids.length);

    if(found_product_ids.length == delete_skus.length){
      var done = 0;
      const product_id_batches = chunkArray(found_product_ids, 3);

      console.log(`Deleting products.....`);

      for (const product_id_batch of product_id_batches) {
        const results = await Promise.all(product_id_batch.map(id=>deleteProductAPI({ productId: id, store: storeName }))).then(values=>values);
        const errors = results.filter(result=>result.productDelete.userErrors).map(result=>result.productDelete.userErrors).flat();
        if(errors.length > 0)console.log("Error deleting products", errors);
        done+=product_id_batch.length;
        console.log(`${done}/${found_product_ids.length} products deleted!`);
      }

      console.log(`All products deleted!`);
    }
  }

  //delete file when its done
  await deleteFile({ filePath });
};

//update collection titles and handles following a given list
export const updateCollectionTitles = async (storeName) => {
  //Step 1: get all required collection names
  const store_product_menu = store_data[storeName]?.product_menu;
  const all_collection_names = Object.keys(store_product_menu).map(range_name=>{
    return store_product_menu[range_name].map(subrange_name=>`${range_name}_${subrange_name}`);
  }).flat();

  // console.log("all_collection_names", all_collection_names.length);

  const updated_collection_names = [
    "Bäckereiöfen","Bain-Marie","BBQ Holzkohlegrill","China-Herde","Dampfgarer","Durchlauf Toaster","Durchlauföfen","Friteusen","Einbaugeräte","Grillplatten","Gyros-/Kebab-Grill","Herd Elektro & Gas","Hot-Dog-Geräte","Hähnchengrill","Induktionsplatten","Kochkessel & Kippbratpfanne","Kochserie 900","Kochserie 900+","Kochserie MAXIMA 700+","Kochserie Modular ALPHA 650","Kochserie OPTIMA 1100","Kochserie OPTIMA 700","Kochserie 600","Kochserie PRO 600","Kochserie Snack 600","Kombidämpfer Direkt","Konvektionsöfen","Lavastein- & Vaporgrill","Mikrowellen","Nudelkocher","Ofen","Panini Kontaktgrill","Regenerationsöfen","Räuchergeräte","Salamander","Salzstationen","Sous-vide Garer","Speisen-Warmhaltung","Teppanyaki","Toaster","Toaster-Salamander","Ultraschnelle Mikrowellenöfen","Vapor Grill","Wärmeschrank","Wärmevitrinen","Wärmebrücken","Hordenwagen","Kombidämpfer","Kombidämpfer Direkt","Schockfroster/-kühler","Besteckpoliermaschinen","Durchschubspülmaschine","Durchschubspülmaschine Crossover","Geschirrspülmaschinen","Gläserspülmaschinen","Set: Geschirrspüler & Spültisch","Korbtransportspülmaschine","Körbe & Zubehör","Osmose Anlage","Spülmaschinen & Gläserspülmaschinen","Topfspülmaschine","Wasserenthärter","Zu- und Auslauftische","Zubehör","Dampfbügelbrett/-eisen","Gewerbewaschmaschinen","Mangel","Rotationstrockner","Schleudermaschinen","Waschmaschine","Waschturm","Wäschetrockner","Eiswürfelbereiter","Flaschenkühlschränke","Gefriertruhen","Getränkespender","Granita- und Sorbetspender","Kühl-/Gefrierzellen","Kühl-/Gefrierschränke","Kühlzellen + Kühlaggregat","Kühl- und Gefriertische","Kühlaufsatzvitrinen GN","Lagerschränke und Boxen","Minibarkühlschränke","Müllkühler","Reif- und Gärschrank","Saladetten","Schnellabkühler/Kombischnellabkühler","Schnellabkühlung","Schockfroster/-kühler","Selbstbedienungsgondeln","Springbrunnen & Wasserkühler","Unterbaukühler","Vitrinentheken","Kühl- & Tiefkühlschränke","Wandkühlregale","Weinkühlschränke","Edelstahlbehälter für Eiscreme","Eiscreme-Lagerung","Eistheken","Eiscrememaschinen","Kombi-Pasteurisierer","Pasteurisiermaschine","Sahne-/Soßenkocher","Sahnemaschine","Fleischtheken","Waffelmaschinen","Bäckereiöfen","Edelstahlmöbel","Gärkühlschränke","Gärschränke für Öfen","Öfen (inkl. Bäckereiöfen)","Drehofen","Planetenrührmixer","Spiralteigknetmaschine (Heavy Duty)","Teigausrollmaschine","Kühl- und Gefriertische","Durchlauföfen","Mozzarellaschneider","Nudelmaschine","Pizza-Former","Pizzaöfen","Spiralteigknetmaschine","Teigausrollmaschine","Teigportionier- & Abrundmaschine","Teigwalzen","Wärmeplatten","Warme Vitrinen","Zubehör / Pizza","Zubehör Pizzeria","Buffets","Buffets/Salattheken","Inseln","Kühlvitrinen","Modulares Self-Service 700","Modulares Self-Service 800","Salatbar-Inseln","Self-Service Drop-In","Self-Service Drop-In Armonia","Tapas- & Sushi-Vitrinen","Wandkühlregale","Warme Vitrinen","Module zur Zusammenstellung","Bain-marie-Wagen","Geschirrkorbwagen","GN-Behälter","Mehl-/Zuckerwagen Edelstahl","Regalwagen","Servierwagen Edelstahl","Speisewagen gekühlt","Spenderwagen","Tellerhalter","Universaltransportwagen","Wärmewagen","Neutrale Wagen","Crusheisbereiter","Crêpes-Platten","Croissant-Wärmevitrine","Frühstücksservice","Espresso-Kaffeemaschinen","Getränkespender","Kaffeemaschinen","Kaffeemühlen","Mischer","Mixer","Profi-Zentrifugen","Schokoladensoßen-Wärmer","Sockel mit Kaffeesatzschublade","Tassenwärmer","Waffelmaschinen","Warmwasserboiler","Wasserenthärter (Edelstahl)","Kühl- und Tiefkühlschränke","Zitruspresse","Aufschnittmaschine","Cutter","Horizontal-Cutter","Fleischmürber","Fleischmischmaschinen","Fleischwölfe","Fleischwolf Standgerät","Gekühlte Fleischwölfe","Gemüseschneider","Gemüsereiniger/-wäscher","Hackblock & Hackbrett","Hackmesser & Parmesanreibe","Kartoffelschäler","Knochensäge","Küchenwaagen","Muschelreinigungsmaschinen","Parmesanreibe","Planetenrührmixer","Stabmixer","Messersterilisatoren","Vakuumbeutel","Vakuummaschinen","Verpackungsfolie","Wurstfüller","Raum- und Servierwagen","Flambierwagen","Frühstücksservice","Hand- & Haartrockner","Kofferwagen","Ausstellungsmöbel","Reinigungsstationen","Rezeptionswagen","Room Service","Servicewagen","Speisenwärmer & Wärmeplatten","Flaschenwagen","Wagen mit Untergestell","Zimmerwagen","Edelstahlpflege","Entkalker","Fettlöser","Glanzspülmittel für Spülmaschinen","Reiniger für starken Schmutz","Spülmittelreiniger für Spülmaschinen","Spülmittelreiniger Öfen","Spülreiniger für Öfen","Abfalleimer Edelstahl","Ablagetische","Bodenablaufrinnen","Chef-Tisch","Eckarbeitstische 90°","Eckedelstahlschrank geschlossen","Eckhängeschränke Edelstahl","Edelstahlschrank","Edelstahlspülbecken","Edelstahltische mit Grundboden","Edelstahltische mit Schubladen","Neutrale Chef-Etageren","Hand- & Haartrockner","Handwaschbecken","Insektenvernichter","Kombiausgussbecken","Lagerregale","Lagerschränke","Müllbeutelhalter","Neutrale & beheizte Chef-Regale","Ozonbehandlung","Papierdispenser","Aluminiumregale","Spülbecken mit Ablage","Tellerwärmer","Vorbereitungskühltische","Wandkühlregale","Wandregale","Wascharmaturen & Pendelbrausen","Geschlossene Waschbecken","Wärmebrücken","Absaugeinheit","Absaugeinheiten mit separatem Luftstrom","Beleuchtungseinsatz","Drehzahlregler","Elektrischer Schaltkasten","Filternde Absaugeinheiten","Wandhauben","Wandhauben mit Kompensation","Wandhauben mit Regler und Licht","Zentralhauben","Zentralhauben mit Kompensation"
  ];

  // console.log("updated_collection_names", updated_collection_names.length);

  //Step 2: query all required collections by name
  //get all products and save them in a file
  var endCursor = "";
  var hasNextPage = true;
  var queried_number = 0;

  console.log(`Querying Collections.....`);

  var filePath = path.resolve(process.cwd(), 'logs', `created_collections.json`);
  while (hasNextPage) {
    const query = `
      query GetCollections {
        collections(first: 200${endCursor != "" ? `, after: "${endCursor}"` : ""}) {
          nodes {
            id
            handle
            title
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    `;

    const result = await shopifyFetch({ query, store: storeName });
    const collections = result?.collections?.nodes;

    endCursor = result.collections.pageInfo.endCursor;
    hasNextPage = result.collections.pageInfo.hasNextPage;

    if(collections && collections.length > 0){
      queried_number+=collections.length;
      console.log(`${queried_number} collections queried!`);

      logRecordToFileNoLimit({ records: collections, filePath });
    }
  };

  const collections = readRecordFromFile({ filePath });

  if(collections.length == 0)return;

  console.log("collections", collections.length);

  //Step 3: match it with the list to get the updated names of the collections
  const updated_collections = all_collection_names.map((old_name, index)=>{
    const found_collection = collections.find(collection=>collection.title == old_name);
    if(found_collection){
      return {
        ...found_collection,
        updated_title: updated_collection_names[index],
        updated_handle: handleize(updated_collection_names[index])
      }
    } else {
      return null;
    }
  }).filter(u=>u);

  var filePath = path.resolve(process.cwd(), 'logs', `updated_collections.json`);
  logRecordToFileNoLimit({ records: updated_collections, filePath });

  console.log("updated_collections", updated_collections.length);

  //Step 4: run mutation to mass-update collection titles
  if(updated_collections.length == 0)return;
  console.log("Updating Collections.....");
  var done = 0;
  const collection_update_batches = chunkArray(updated_collections, 10);
  var errors = [];

  for (const collection_update_batch of collection_update_batches) {
    const batch_result = await Promise.all(collection_update_batch.map(({ id, updated_title, updated_handle })=>{
      return collectionUpdate({ record: { id, updated_title, updated_handle } ,data: {
        id,
        title: updated_title,
        handle: updated_handle
      }, store: storeName, feature: "updateCollectionTitle" })
    })).then(values=>values);

    const batch_errors = batch_result.filter(result=>result.status == "error");
    if(batch_errors.length > 0){
      errors = errors.concat(batch_errors);
      // break;
    };

    const batch_success_count = batch_result.filter(result=>result.status == "success").length;
    done+=batch_success_count;
    console.log(`*****  ${done}/${updated_collections.length} collections updated!  *****`);
  };

  console.log(`*****  All collections updated!  *****`);
  if(errors.length > 0)console.log("errors", errors);
};