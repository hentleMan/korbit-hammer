var fs = require("fs");

var { io } = require("../io.js");


describe("io.js", function() {
	var path, data;
	
	beforeEach(function() {
		path = "./spec/io_test.txt";
		data = "apple pinple pine!";
	});
	
	it("should be able to write data to file asynchronously", function(done) {
		io(path).writeFile(data).then(function() {
			expect(function() {
				fs.accessSync(path)
			}).not.toThrow();
			done();
		});
	});
	
	it("should be able to read file asynchronously", function(done) {
		io(path).readFile().then(function(result) {
			expect(result).toBe(data);
			fs.unlinkSync(path);
			done();
		});
	});
	
// 	it("should be able to write data to file providing stream", function() {
		
// 	});
	
// 	it("should be able to read data providing stream", function() {
		
// 	});
});