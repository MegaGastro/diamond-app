import { chunkArray, createProductAPI, getAllPublications, logRecordToFile, publishablePublish, removeArrayDuplicates, shopifyFetch, store_data, uploadS3FilesToShopify } from "../../helpers/index.js";

export const syncProductChangesDaily = async ({ 
  product_list,
  store,
  newly_created_diamond_products
}) => {
  var shopify_products = [];
  var create_result = [];

  try {
    if(product_list.length == 0)return;
    
    //Step 1: Get all Diamond-updated Products from Shopify by Diamond ID
    const diamond_product_skus = product_list.map(product=>`sku:${product.id}`).join(" OR ");

    const get_products_by_sku_query = `
      query getProducts {
        products(first: 250, query: "${diamond_product_skus}") {
          nodes {
            id
            title
            status
            media(first: 250, query: "media_type:IMAGE") {
              nodes {
                ... on MediaImage {
                  id
                  image {
                    url
                  }
                }
              }
            }
            variants(first: 1) {
              nodes {
                id
                sku
                compareAtPrice
                price
              }
            }
          }
        }
      }
    `;

    const result = await shopifyFetch({ query: get_products_by_sku_query, store });
    shopify_products = result.products.nodes;

    //Step 2: Check if there are newly-created Diamond Product to sync to Shopify (is_old == false and not exist in Shopify and product id does not end with LIQ or 2EME)
    const diamond_product_ids_in_shopify = shopify_products.map(product=>product.variants.nodes[0].sku);

    const batch_newly_created_diamond_products = product_list.filter(product=>((!diamond_product_ids_in_shopify.includes(product.id) && product.attributes.is_old == false && !product.id.endsWith("LIQ") && !product.id.endsWith("2EME"))));
    newly_created_diamond_products = newly_created_diamond_products.concat(batch_newly_created_diamond_products);

    //Step 3: Sync newly-created Products
    if(batch_newly_created_diamond_products.length > 0){
      console.log(`Getting All Publications from ${store}.....`);

      //get all publications
      const get_publication_result = await getAllPublications({
        store
      });
      const publications = get_publication_result.publications.nodes
      
      if(publications.length == 0)throw "There are no publications";

      console.log(`${batch_newly_created_diamond_products.length} new products found. Creating.....`);

      const limit_per_batch = 3;
      const product_list_batches = chunkArray(batch_newly_created_diamond_products, limit_per_batch);
      var done = 0;
      var error_file_number = 1;

      for (const product_list_batch of product_list_batches) {
        console.log("product_list_batch", product_list_batch.map(prod=>prod.id));

        const result = await createProductBatch({ product_list: product_list_batch, store, publications });

        done+=product_list_batch.length;
        console.log(`***** ${done}/${batch_newly_created_diamond_products.length} products created! *****`);

        //log error
        if(result.status == "success"){
          create_result = create_result.concat(result.create_result);
        } else {
          const failed_diamond_products = result.create_result.filter((product_result)=>!product_result.variant).map(product_result=>product_result.productData);
          if(failed_diamond_products.length > 0){
            failed_diamond_products.forEach(product=>{
              console.log(`***** Failed creating product: ${product.attributes.name}! *****`);
            });

            //log error diamond product records to file for later check
            const errorPath = path.resolve(process.cwd(), 'logs', 'error_product_sync', `errors_${error_file_number}_create.json`);
            error_file_number = logRecordToFile({ records: failed_diamond_products, filePath: errorPath });
          };

          throw {
            message: "Failed Creating Products - Sync!",
            errors: result.errors
          };
        }
      };
    };

    //Step 4: Check if there are newly-disabled Diamond Products to sync to Shopify (is_old == true but ACTIVE shopify product)
    const newly_disabled_diamond_products = product_list.filter(diamond_product=>{
      const shopify_product = shopify_products.find(shopify_product=>diamond_product.id == shopify_product.variants.nodes[0].sku);
      return !newly_created_diamond_products.find(created_product=>created_product.id == diamond_product.id) && diamond_product.attributes.is_old == true && shopify_product && shopify_product.status != "DRAFT";
    }).map(product=>product.id);
    var shopify_products_to_disable = shopify_products.filter(product=>newly_disabled_diamond_products.includes(product.variants.nodes[0].sku))

    //Step 5: Sync newly-disabled Products
    if(shopify_products_to_disable.length > 0){
      console.log(`${shopify_products_to_disable.length} disabled products found. Disabling.....`);

      const limit_per_batch = 5;
      const product_list_batches = chunkArray(shopify_products_to_disable, limit_per_batch);
      var done = 0;
      var error_file_number = 1;
      
      for (const product_list_batch of product_list_batches) {
        console.log("product_list_batch", product_list_batch.map(prod=>prod.id));

        const disable_result = await Promise.all(product_list_batch.map(product=>updateProductStatus({ productId: product.id, store, productData: product })));

        done+=product_list_batch.length;
        console.log(`***** ${done}/${shopify_products_to_disable.length} products disabled! *****`);
        
        //log errors
        if(disable_result.find(result=>result.status == "error")){
          const failed_diamond_products = disable_result.filter((product_result)=>product_result.status == "error").map(product_result=>product_result.productData);

          if(failed_diamond_products.length > 0){
            failed_diamond_products.forEach(product=>{
              console.log(`***** Failed disabling product: ${product.attributes.name}! *****`);
            });

            //log error diamond product records to file for later check
            const errorPath = path.resolve(process.cwd(), 'logs', 'error_product_sync', `errors_${error_file_number}_disable.json`);
            error_file_number = logRecordToFile({ records: failed_diamond_products, filePath: errorPath });
          };

          throw {
            message: "Failed Disabling products - Sync!",
            errors: disable_result.find(result=>result.status == "error").errors
          };
        };
      };
    };

    //Step 6: Check if there are products with recently-updated prices
    const updated_price_products = product_list.filter(product=>{
      const found_shopify_product = shopify_products.find(shopify_product=>shopify_product.variants.nodes[0].sku == product.id);
      return found_shopify_product && Number(found_shopify_product.variants.nodes[0].compareAtPrice) != Number(product.attributes.price.catalog);
    }).map(product=>{
      const found_shopify_product = shopify_products.find(shopify_product=>shopify_product.variants.nodes[0].sku == product.id);
      return {
        productData: product,
        productId: found_shopify_product.id,
        variantId: found_shopify_product.variants.nodes[0].id
      }
    });

    //Step 7: Sync newly-updated-price products
    if(updated_price_products.length > 0){
      console.log(`${updated_price_products.length} price-updated products found. Updating.....`);

      var done = 0;

      const update_batches = chunkArray(updated_price_products, 10);

      for (const update_batch of update_batches) {
        const update_price_result = await Promise.all(update_batch.map(({ productData, productId, variantId })=>{
          return updateProductVariant({ 
            productData,
            store,
            productId,
            variantId
          })
        })).then(values=>{return values.map(result=>result.productVariantsBulkUpdate.userErrors).flat()});
    
        if(update_price_result.length > 0)throw update_price_result;

        done+=update_batch.length;
        console.log(`*****  ${done}/${updated_price_products.length} product prices Updated!  *****`);
      };

      console.log(`*****  All product prices updated!  *****`);
    };

    //Step 8: Check if there are product with recently-updated images
    var add_image_products = [];
    var delete_image_ids = [];

    product_list.forEach(product=>{
      const found_shopify_product = shopify_products.find(shopify_product=>shopify_product.variants.nodes[0].sku == product.id);
      
      if(!found_shopify_product)return false;

      const shopify_product_images = found_shopify_product?.media?.nodes;
      const diamond_product_images = product.attributes.media.images.filter(image_object=>image_object.big).map(image_object=>image_object.big);

      //get newly-added images
      const newly_added_images = diamond_product_images.filter(diamond_image=>{
        const diamond_image_name = diamond_image.split("/").at(-1).split(".")[0];
        return !shopify_product_images.find(shopify_image=>shopify_image?.image?.url.includes(diamond_image_name));
      });

      if(newly_added_images.length > 0)add_image_products.push({
        productId: found_shopify_product.id,
        images: newly_added_images
      });

      //get newly-deleted images
      const newly_deleted_images = shopify_product_images.filter(shopify_image=>{
        const shopify_image_name = shopify_image?.image?.url.split("/").at(-1).split(".")[0].split("_")[0];
        return !diamond_product_images.find(diamond_image=>diamond_image.includes(shopify_image_name));
      }).map(shopify_image=>shopify_image.id);

      if(newly_deleted_images.length > 0)delete_image_ids = delete_image_ids.concat(newly_deleted_images);
    });
    
    //Step 9: Sync newly-updated-images
    if(add_image_products.length > 0){
      console.log(`${add_image_products.length} products with added images detected! Updating.....`);
      const add_image_product_batches = chunkArray(add_image_products, 5);
      var done = 0;
      const mutation = `
        mutation UpdateProductWithNewMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
          productUpdate(product: $product, media: $media) {
            product {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      for (const add_image_product_batch of add_image_product_batches) {
        const errors = await Promise.all(add_image_product_batch.map(product=>{
          const variables = {
            product: {
              id: product.productId,
            },
            media: product.images.map(image=>{
              return {
                originalSource: image,
                alt: `Uploaded ${store} Image`,
                mediaContentType: "IMAGE"
              }
            })
          };

          return shopifyFetch({ query: mutation, variables, store });
        })).then(values=>values.map(value=>value.productUpdate.userErrors).flat());

        if(errors.length > 0)console.log("errors adding product images", errors);

        done+=add_image_product_batch.length;
        console.log(`${done}/${add_image_products.length} products updated!`);
      }

      console.log(`Added all necessary product images!`);
    };
    if(delete_image_ids.length > 0){
      console.log(`${delete_image_ids.length} deleted images detected! Deleting.....`);
      const delete_image_id_batches = chunkArray(delete_image_ids, 25);
      var done = 0;
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

      for (const delete_image_id_batch of delete_image_id_batches) {
        const variables = {
          fileIds: delete_image_id_batch
        };

        const delete_result = await shopifyFetch({ query: mutation, variables, store });
        const deletedIds = delete_result.fileDelete.deletedFileIds;

        if(delete_result.fileDelete.userErrors.length > 0)console.log("Error Deleting product images", delete_result.fileDelete.userErrors);

        done+=deletedIds.length;
        console.log(`*****  ${done}/${delete_image_ids.length} images deleted!  *****`);
      };

      console.log("Deleted all necessary product images!");
    };

    return {
      status: "success",
      newly_created_diamond_products,
      batch_queried_shopify_products: shopify_products,
      batch_created_shopify_products: create_result
    };
  } catch (error) {
    console.error('❌ Error syncing product batch:', error);
    return {
      status: "error",
      error,
      newly_created_diamond_products,
      batch_queried_shopify_products: shopify_products,
      batch_created_shopify_products: create_result
    };
  }
};

export const syncProductChangesHourly = async ({ 
  product_list,
  store
}) => {
  try {
    if(product_list.length == 0)return;
    
    //Step 1: Get all Diamond-updated Products from Shopify by Diamond ID
    const diamond_product_skus = product_list.map(product=>`sku:${product.id}`).join(" OR ");

    const get_products_by_sku_query = `
      query getProducts {
        products(first: 250, query: "${diamond_product_skus}") {
          nodes {
            id
            variants(first: 1) {
              nodes {
                id
                sku
                inventoryQuantity
                inventoryItem {
                  id
                }
              }
            }
          }
        }
      }
    `;

    const result = await shopifyFetch({ query: get_products_by_sku_query, store });
    const shopify_products = result.products.nodes;

    //Step 2: Check if there are newly-updated-stock Diamond Products
    const stock_updates = [];
    product_list.forEach(diamond_product=>{
      const found_shopify_product = shopify_products.find(shopify_product=>shopify_product.variants.nodes[0].sku == diamond_product.id);

      if(!found_shopify_product)return;

      const shopify_product_stock = Number(found_shopify_product.variants.nodes[0].inventoryQuantity);
      const diamond_product_stock = Number(diamond_product.attributes.availability);

      if(shopify_product_stock != diamond_product_stock)stock_updates.push({
        delta: diamond_product_stock - shopify_product_stock,
        inventoryItemId: found_shopify_product.variants.nodes[0].inventoryItem.id,
        locationId: process.env[`${store}_LOCATION_ID`]
      })
    });

    //Step 3: Sync newly-updated-stock Diamond Products
    if(stock_updates.length > 0){
      console.log(`${stock_updates.length} new stock updates found. Syncing.....`);

      const limit_per_batch = 25;
      const stock_update_batches = chunkArray(stock_updates, limit_per_batch);
      var done = 0;

      for (const stock_update_batch of stock_update_batches) {
        const result = await updateProductVariantInventory({
          changes: stock_update_batch.map(({ delta, inventoryItemId, locationId })=>{
            return {
              delta,
              inventoryItemId,
              locationId
            }
          }),
          store
        });

        if(result.status == "error")throw result.errors;

        done+=stock_update_batch.length;
        console.log(`***** ${done}/${stock_updates.length} stock updates synced! *****`);
      };

      console.log(`All new stock updates Synced!`);
    };

    return {
      status: "success"
    };
  } catch (error) {
    console.error('❌ Error syncing product batch:', error);
    return {
      status: "error",
      error
    };
  }
};

export const getProductList = async ({ store, access_token, action, frequency }) => {
  var number_of_hours_rollback;
  switch (frequency) {
    case "hourly":
      number_of_hours_rollback = 1;
      break;
    case "daily":
      number_of_hours_rollback = 24;
      break;
    default:
      number_of_hours_rollback = 1;
      break;
  }

  const date = new Date(Date.now() - number_of_hours_rollback * 60 * 60 * 1000); // minus number_of_hours_rollback hours

  const pad = (n) => String(n).padStart(2, '0');

  const requested_time = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  // const requested_time = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` + `06:00:00`;

  console.log("requested_time", requested_time);
  
  var url;
  switch (action) {
    case "migrate":
      url = `${process.env[`${store}_PRODUCT_EXPORT_API`]}?filter[is_old][value]=0`;
      break;
    case "sync":
      url = `${process.env[`${store}_PRODUCT_EXPORT_API`]}?filter[products.updated_at][value]=${requested_time}&filter[products.updated_at][op]=gt`;
      break;
    default:
      break;
  }

  return fetch(url, {
    method: "GET",
    headers: {
      "Accept-Language": "de",
      "Authorization": `Bearer ${access_token}`
    },
  }).then(async response => {
    const contentType = response.headers.get('content-type');

    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    } else {
      // Not JSON, handle accordingly
      const text = await response.text(); // Read raw text (HTML, error msg, etc.)
      console.error('Non-JSON error:', text);
      return {};
    }
  })
  .catch(err => {
    console.error('Fetch failed:', err.message);
  });;
};  

export const createProduct = async ({ productData, store, uploaded_files }) => {
  try {
    var metafields = [];
    var product_files = [];
    if(uploaded_files && uploaded_files.length > 0)product_files = product_files.concat(uploaded_files);

    //Step 1: Add default metafield data
    store_data[store].remaining_metafield_keys.forEach(key=>{
      if(productData.attributes[key] !== null && productData.attributes[key] !== ""){
        metafields.push(store_data[store].product_all_metafields[key](productData.attributes[key]));
      }
    });

    //Step 2: Check and Upload product documents to Shopify
    if(productData.attributes.media.documents.length > 0){
      const existed_documents = productData.attributes.media.documents.map((document)=>{
        const document_name = document.url.split("/").at(-1).replaceAll("%", "_").trim();
        return product_files.find(file=>{
          const alt_file_name = file.alt.replace(`Uploaded ${store} File: `,"");
          return alt_file_name == document_name;
        });
      }).filter(document=>document != null);
      
      // product_files.filter(file=>productData.attributes.media.documents.find(document=>{
      //   const document_name = document.url.split("/").at(-1).replaceAll("%", "_").trim();
      //   return file.alt.includes(document_name);
      // }));

      metafields.push({
        namespace: "product",
        key: "documents",
        type: "list.file_reference",
        value: JSON.stringify(existed_documents.map(file=>file.id))
      });
      metafields.push({
        namespace: "product",
        key: "json_documents",
        type: "json",
        value: JSON.stringify(productData.attributes.media.documents)
      });
    };

    //Step 3: Check and Upload product spare-parts document to Shopify
    if(productData.attributes.media["spare-parts"].length > 0){
      const existed_spare_parts = productData.attributes.media["spare-parts"].map((media)=>{
        const media_name = media.url.split("/").at(-1).replaceAll("%", "_").trim();
        return product_files.find(file=>{
          const alt_file_name = file.alt.replace(`Uploaded ${store} File: `,"");
          return alt_file_name == media_name;
        });
      }).filter(document=>document!=null);
      
      // product_files.filter(file=>productData.attributes.media["spare-parts"].find(media=>{
      //   const media_name = media.url.split("/").at(-1).replaceAll("%", "_").trim();
      //   return file.alt.includes(media_name);
      // }));

      metafields.push({
        namespace: "product",
        key: "spare_parts",
        type: "list.file_reference",
        value: JSON.stringify(existed_spare_parts.map(file=>file.id))
      });

      metafields.push({
        namespace: "product",
        key: "json_spare_parts",
        type: "json",
        value: JSON.stringify(productData.attributes.media["spare-parts"])
      });
    };

    //Step 4: Create product via Graphql API with productData
    const result = await createProductAPI({ productData, store, metafields });
    const product = result.productCreate.product;

    if(result.productCreate.userErrors.length > 0)throw result.productCreate.userErrors;

    return {
      id: product?.id,
      variant: {
        ...product.variants.nodes[0],
        sku: productData.id
      },
      productData
    };
  } catch (error) {
    console.error('❌ Error:', error);
    return {
      error,
      variant: null,
      productData,
      id: null
    };
  }
};

export const updateProductVariant = async ({ productData, store, productId, variantId }) => {
  const update_product_variant_mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        product {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    productId,
    variants: [{
      id: variantId,
      inventoryItem: {
        sku: productData.id,
        tracked: true
      },
      price: productData.attributes.price.promo,
      compareAtPrice: productData.attributes.price.catalog
    }]
  };

  return shopifyFetch({ query: update_product_variant_mutation, variables, store });
};

export const updateInventoryItem = async ({ id, input, store }) => {
  const mutation = `
    mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem {
          id
        }
        userErrors {
          message
        }
      }
    }
  `;

  const variables = {
    id,
    input
  };

  const result = await shopifyFetch({ query: mutation, variables, store });

  return {
    status: result.inventoryItemUpdate.userErrors.length > 0 ? "error" : "success",
    errors: result.inventoryItemUpdate.userErrors
  };
};

export const updateProductVariantInventory = async ({ changes, store }) => {
  const mutation = `
    mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        userErrors {
          field
          message
        }
        inventoryAdjustmentGroup {
          createdAt
        }
      }
    }
  `;

  const variables = {
    input: {
      changes,
      reason: "received",
      name: "available"
    }
  };

  const result = await shopifyFetch({ query: mutation, variables, store });

  return {
    status: result.inventoryAdjustQuantities.userErrors.length > 0 ? "error" : "success",
    errors: result.inventoryAdjustQuantities.userErrors
  };
};

export const updateProductStatus = async ({ productId, store, status = "DRAFT", productData }) => {
  const update_product_mutation = `
    mutation {
      productUpdate(product: {id: "${productId}", status: ${status}}) {
        product {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result =  await shopifyFetch({ query: update_product_mutation, store });
  const product_updated = result.productUpdate.product;
  if(product_updated){
    return {
      productId,
      status: "success",
      productData
    }
  }else{
    return {
      productId,
      status: "error",
      errors: result.productUpdate.userErrors,
      productData
    }
  }
};

export const updateProductRelationships = async ({ diamond_products, queried_shopify_products, created_shopify_products, store }) => {
  //get all referenced Shopify product skus
  var referenced_shopify_product_skus = removeArrayDuplicates(diamond_products.map(product=>{
    var sku_array = [];
    if(product.relationships?.includedProducts?.data?.length > 0)sku_array = sku_array.concat(product.relationships?.includedProducts?.data.map(p=>p.id));
    if(product.attributes.accessories.length > 0)sku_array = sku_array.concat(product.attributes.accessories);
    if(product.attributes.replacement_product_id != null)sku_array = sku_array.concat([product.attributes.replacement_product_id]);
    return sku_array;
  }).flat());

  //get all referrer Shopify product skus
  var referrer_shopify_product_skus = removeArrayDuplicates(diamond_products.map(product=>product.id));

  //get all needed Shopify product skus
  const needed_shopify_product_skus = removeArrayDuplicates(referrer_shopify_product_skus.concat(referenced_shopify_product_skus));

  if(needed_shopify_product_skus.length == 0) return;

  //all needed Shopify products
  var needed_shopify_products = [];

  //check if there are any needed shopify product in created_shopify_products
  var created_shopify_products_in_relationship = created_shopify_products.filter(shopify_product=>needed_shopify_product_skus.includes(shopify_product.variant.sku)).map(shopify_product=>{
    return {
      id: shopify_product.id,
      sku: shopify_product.variant.sku
    }
  });
  if(created_shopify_products_in_relationship.length > 0)needed_shopify_products = needed_shopify_products.concat(created_shopify_products_in_relationship);

  //check if there are any needed shopify product in queried_shopify_products
  var queried_shopify_products_in_relationship = queried_shopify_products.filter(shopify_product=>needed_shopify_product_skus.includes(shopify_product.variants.nodes[0].sku)).map(shopify_product=>{
    return {
      id: shopify_product.id,
      sku: shopify_product.variants.nodes[0].sku
    }
  });
  if(queried_shopify_products_in_relationship.length > 0)needed_shopify_products = needed_shopify_products.concat(queried_shopify_products_in_relationship);

  //get missing Shopify product skus
  const available_skus = needed_shopify_products.map(product=>product.sku);
  const missing_skus = needed_shopify_product_skus.filter(needed_sku=>!available_skus.includes(needed_sku));

  console.log(`Getting needed products from ${store}.....`);

  //query the missing needed Shopify products
  if(missing_skus.length > 0){
    const product_sku_batches = chunkArray(missing_skus, 100);
    for (const product_sku_batch of product_sku_batches) {
      // get Shopify products version of the list
      const shopify_get_product_by_sku_query = `
        query getProducts {
          products(first: 250, query: "${product_sku_batch.map(sku=>`sku:${sku}`).join(" OR ")}") {
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

      const result = await shopifyFetch({ query: shopify_get_product_by_sku_query, store });
      const shopify_products = result.products.nodes;

      needed_shopify_products = needed_shopify_products.concat(shopify_products.map(product=>{
        return {
          id: product.id,
          sku: product.variants.nodes[0].sku
        }
      }));
    };
  };

  //get referrer Shopify products
  const referrer_shopify_products = needed_shopify_products.filter(shopify_product=>referrer_shopify_product_skus.includes(shopify_product.sku)).map(shopify_product=>{
    const diamond_product = diamond_products.find(diamond_product=>diamond_product.id == shopify_product.sku);
    return {
      ...shopify_product,
      includedProducts: diamond_product.relationships?.includedProducts?.data?.map(p=>p.id) || [],
      accessories: diamond_product.attributes.accessories || [],
      replacement_product_id: diamond_product.attributes.replacement_product_id || null
    }
  });

  console.log(`Updating product metafields in ${store}.....`);

  //update reference product metafields
  const metafields = [];
  referrer_shopify_products.forEach(product=>{
    if(product.accessories.length > 0)metafields.push({
      ownerId: product.id,
      key: "accessories",
      namespace: "product",
      type: "list.product_reference",
      value: JSON.stringify(needed_shopify_products.filter(p=>product.accessories.includes(p.sku)).map(p=>p.id))
    });
    if(product.includedProducts.length > 0)metafields.push({
      ownerId: product.id,
      key: "includedProducts",
      namespace: "product",
      type: "list.product_reference",
      value: JSON.stringify(needed_shopify_products.filter(p=>product.includedProducts.includes(p.sku)).map(p=>p.id))
    });
    if(product.replacement_product_id != null && needed_shopify_products.find(p=>p.sku == product.replacement_product_id))metafields.push({
      ownerId: product.id,
      key: "replacement_product_id",
      namespace: "product",
      type: "product_reference",
      value: needed_shopify_products.find(p=>p.sku == product.replacement_product_id)?.id
    });
  });

  const metafields_set_mutation = `
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const metafield_batches = chunkArray(metafields, 25);
  var errors = [];
  var done = 0;

  for (const metafield_batch of metafield_batches) {
    const value = await shopifyFetch({ query: metafields_set_mutation, variables: {
      metafields: metafield_batch
    }, store });

    done+=metafield_batch.length;
    console.log(`***** ${done}/${metafields.length} product metafields updated! *****`);
    errors = errors.concat(value.metafieldsSet.userErrors);
  };

  console.log(`***** All product metafields updated! *****`);

  return {
    status: errors.length > 0 ? "error" : "success",
    errors
  }
};

export const createProductBatch = async ({ product_list, store, publications }) => {
  var create_result = [];

  try {
    //get product's requested files
    const all_product_files = product_list.map(product=>product.attributes.media.documents.concat(product.attributes.media["spare-parts"])).flat();
    var uploaded_files = [];
    var remaining_files = all_product_files;

    //Step 1: upload all requested files first
    if(all_product_files.length > 0){
      const all_product_file_names = removeArrayDuplicates(all_product_files.map(product=>product.url.split("/").at(-1).split(".")[0].replaceAll("%", "_").trim()));
      const all_product_file_name_batches = chunkArray(all_product_file_names, 100);
      
      // get pre-uploaded files
      for (const product_file_name_batch of all_product_file_name_batches) {
        const get_files_by_name_query = `
          query getFiles {
            files(first: 250, query: "${product_file_name_batch.map(name=>`filename:${name}`).join(" OR ")}") {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                alt
              }
            }
          }
        `;

        const result = await shopifyFetch({ query: get_files_by_name_query, store });
        const files = result.files.nodes;

        if(files.length > 0)uploaded_files = uploaded_files.concat(files);
      };

      // filter out pre-uploaded files from all_product_files to get remaining requested files
      if(uploaded_files.length > 0){
        const uploaded_file_alts = uploaded_files.map(file=>file.alt);
        remaining_files = all_product_files.filter(file=>{
          const file_name = file.url.split("/").at(-1).replaceAll("%", "_").trim();
          return !uploaded_file_alts.find(alt=>alt.includes(`Uploaded ${store} File: ${file_name}`));
        });
      };

      const unique_remaining_file_names = removeArrayDuplicates(remaining_files.map(file=>file.url.split("/").at(-1).replaceAll("%", "_")));
      const unique_remaining_files = [];

      unique_remaining_file_names.forEach(name=>{
        unique_remaining_files.push(remaining_files.find(file=>{
          const file_name = file.url.split("/").at(-1).replaceAll("%", "_");
          return file_name == name;
        }));
      });

      //upload remaining requested files
      if(unique_remaining_files.length > 0){
        const remaining_file_batches = chunkArray(unique_remaining_files, 5);

        for (const remaining_file_batch of remaining_file_batches) {
          const upload_file_result = await uploadS3FilesToShopify({ documents: remaining_file_batch, store });

          if(upload_file_result && upload_file_result.files.length > 0){
            uploaded_files = uploaded_files.concat(upload_file_result.files);
          }
        }
      };
    };

    //Step 2: create product records
    create_result = await Promise.all(product_list.map(productData=>createProduct({ productData, store, uploaded_files }))).then(values=>{
      return values;
    });

    if(create_result.find(result=>result.error))throw create_result.filter(result=>result.error).map(result=>result.error);

    //Step 3: update products price, compare-at-price, sku
    const update_price_result = await Promise.all(create_result.map(result=>updateProductVariant({ 
      productData: result.productData,
      store,
      productId: result.id,
      variantId: result.variant.id
    }))).then(values=>{return values.map(result=>result.productVariantsBulkUpdate.userErrors).flat()});

    if(update_price_result.length > 0)throw update_price_result;

    //Step 4: update products weight and weight unit
    const filtered_create_result_by_weight = create_result.filter(result=>result.productData.attributes.weight && result.productData.attributes.weight_unit);
    const update_inventory_weight = filtered_create_result_by_weight.length > 0 ? await Promise.all(filtered_create_result_by_weight.map(result=>updateInventoryItem({
      id: result.variant.inventoryItem.id,
      input: {
        measurement: {
          weight: {
            unit: "KILOGRAMS",
            value: Number(result.productData.attributes.weight)
          }
        }
      },
      store
    }))).then(values=>{
      return {
        errors: values.map(result=>result.errors).flat()
      }
    }) : {
      errors: []
    };

    if(update_inventory_weight.errors.length > 0)throw update_inventory_weight.errors;

    //Step 5: update products quantity
    const filtered_create_result_by_availability = create_result.filter(result=>Number(result.productData.attributes.availability) > 0);
    const update_inventory_result = filtered_create_result_by_availability.length > 0 ? await updateProductVariantInventory({
      changes: filtered_create_result_by_availability.map(result=>{
        return {
          delta: Number(result.productData.attributes.availability),
          inventoryItemId: result.variant.inventoryItem.id,
          locationId: process.env[`${store}_LOCATION_ID`]
        }
      }),
      store
    }) : {
      errors: []
    };

    if(update_inventory_result.errors.length > 0)throw update_inventory_result.errors;

    //Step 6: publish product to all channels available
    const publication_records = create_result.map(product=>{
      return publications.map(publication=>{
        return { id: product.id, publication }
      });
    }).flat();
    const publication_record_batches = chunkArray(publication_records, 30);
    var publication_errors = [];

    for (const publication_record_batch of publication_record_batches) {
      const publish_product_errors = await Promise.all(publication_record_batch.map(record=>
        publishablePublish({ id: record.id, publication: record.publication, store })
      )).then(values=>values.map(value=>value.publishablePublish.userErrors));

      publication_errors = publication_errors.concat(publish_product_errors.flat());
    };

    if(publication_errors.length > 0)throw publication_errors;

    return {
      status: "success",
      create_result,
      errors: []
    }
  } catch (error) {
    return {
      status: "error",
      errors: error,
      create_result
    };
  }
};